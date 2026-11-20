#!/usr/bin/env python3
"""KDE/Qt system tray companion, matching the Windows OpenClaw Direct Tools tray."""

import argparse
import json
import logging
import os
import sys
import time
from pathlib import Path

from PySide6.QtCore import QProcess, Qt, QTimer, QUrl
from PySide6.QtGui import QAction, QColor, QDesktopServices, QIcon, QPainter, QPen, QPixmap
from PySide6.QtNetwork import QLocalServer, QLocalSocket, QNetworkAccessManager, QNetworkReply, QNetworkRequest
from PySide6.QtWidgets import QApplication, QMenu, QSystemTrayIcon

APP_NAME = "OpenClaw Direct Tools"
APP_DIR = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "openclaw-chatgpt-bridge"
CONFIG_FILE = APP_DIR / "config.json"
SOCKET_FILE = Path(os.environ.get("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")) / "openclaw-direct-tools-tray.sock"
LOG_FILE = Path(os.environ.get("XDG_STATE_HOME", Path.home() / ".local/state")) / "openclaw-chatgpt-bridge/tray.log"

COLORS = {
    "Ready": "#22c55e",
    "Pending": "#eab308",
    "Offline": "#ef4444",
    "Tool": "#3b82f6",
    "Computer": "#9333ea",
}


def make_icon(kind):
    """Reproduce the GDI+ 32x32 Windows tray glyphs and their exact colors."""
    pixmap = QPixmap(32, 32)
    pixmap.fill(Qt.GlobalColor.transparent)
    painter = QPainter(pixmap)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setBrush(QColor(COLORS[kind]))
    painter.setPen(QPen(Qt.GlobalColor.white, 2))
    painter.drawEllipse(3, 3, 26, 26)
    painter.setPen(QPen(Qt.GlobalColor.white, 2.6, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
    if kind == "Tool":
        painter.drawLine(10, 22, 20, 12)
        painter.drawLine(17, 8, 23, 14)
        painter.drawLine(19, 7, 25, 13)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(Qt.GlobalColor.white)
        painter.drawEllipse(7, 19, 6, 6)
    elif kind == "Computer":
        painter.setPen(QPen(Qt.GlobalColor.white, 2))
        painter.setBrush(Qt.BrushStyle.NoBrush)
        painter.drawRect(7, 8, 18, 13)
        painter.setPen(Qt.PenStyle.NoPen)
        painter.setBrush(Qt.GlobalColor.white)
        painter.drawRect(10, 11, 12, 7)
        painter.setPen(QPen(Qt.GlobalColor.white, 2, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
        painter.drawLine(16, 21, 16, 24)
        painter.drawLine(11, 25, 21, 25)
    painter.end()
    return QIcon(pixmap)


def classify_status(components, *, ever_ready, startup_grace_until, restart_until, now):
    if not components["Configured"]:
        return "CONFIG MISSING"
    all_ready = all(components[name] for name in ("Gateway", "Bridge", "Tunnel"))
    if all_ready:
        return "READY"
    if restart_until and now < restart_until:
        return "RESTARTING"
    if not ever_ready and now < startup_grace_until:
        return "STARTING"
    if any(components[name] for name in ("Gateway", "Bridge", "Tunnel")):
        return "PARTIAL"
    return "OFFLINE"


def send_control(command):
    """Send quit/status over a private same-user Unix socket; no GUI required."""
    socket = QLocalSocket()
    socket.connectToServer(str(SOCKET_FILE))
    if not socket.waitForConnected(700):
        return command == "quit"
    socket.write((command + "\n").encode("ascii"))
    if not socket.waitForBytesWritten(700):
        return False
    if command == "status":
        if not socket.waitForReadyRead(1000):
            return False
        print(bytes(socket.readAll()).decode("utf-8", "replace").strip())
    socket.disconnectFromServer()
    return True


class TrayCompanion:
    def __init__(self, app):
        self.app = app
        self.config = None
        self.config_signature = None
        self.monitor_url = None
        self.startup_grace_until = time.monotonic() + 300
        self.ever_ready = False
        self.ready_was_shown = False
        self.restart_until = 0
        self.last_state = None
        self.base_icon = "Pending"
        self.activity_icon = None
        self.bridge_available = False
        self.status_in_flight = False
        self.activity_in_flight = False
        self.operations = set()
        self.icons = {name: make_icon(name) for name in COLORS}
        self.network = QNetworkAccessManager()

        self.menu = QMenu()
        self.state_item = self._add_disabled("Status: STARTING")
        self.gateway_item = self._add_disabled("Gateway: Checking")
        self.bridge_item = self._add_disabled("MCP Bridge: Checking")
        self.tunnel_item = self._add_disabled("Secure MCP Tunnel: Checking")
        self.menu.addSeparator()
        self.monitor_item = self.menu.addAction("Open Monitor")
        self.cursor_item = self.menu.addAction("Show AI Cursor")
        self.cursor_item.setCheckable(True)
        self.cursor_item.setChecked(True)
        self.cursor_item.setEnabled(False)
        self.restart_item = self.menu.addAction("Restart Bridge")
        self.stop_item = self.menu.addAction("Stop OpenClaw Direct Tools")
        self.menu.addSeparator()
        self.exit_item = self.menu.addAction("Exit tray app")

        self.tray = QSystemTrayIcon(self.icons["Pending"], self.app)
        self.tray.setToolTip(APP_NAME + ": Starting")
        self.tray.setContextMenu(self.menu)
        self.tray.activated.connect(self.on_tray_activated)
        self.monitor_item.triggered.connect(self.open_monitor)
        self.cursor_item.triggered.connect(self.set_cursor)
        self.restart_item.triggered.connect(self.restart_bridge)
        self.stop_item.triggered.connect(self.stop_services)
        self.exit_item.triggered.connect(self.app.quit)
        self.menu.aboutToShow.connect(self.refresh_cursor)
        self.tray.show()

        self.server = QLocalServer(self.app)
        self.server.newConnection.connect(self.accept_connections)
        if not self.server.listen(str(SOCKET_FILE)):
            socket = QLocalSocket()
            socket.connectToServer(str(SOCKET_FILE))
            if socket.waitForConnected(300):
                raise RuntimeError("OpenClaw tray is already running.")
            QLocalServer.removeServer(str(SOCKET_FILE))
            if not self.server.listen(str(SOCKET_FILE)):
                raise RuntimeError("Cannot establish tray singleton socket: " + self.server.errorString())
        self.app.aboutToQuit.connect(self.cleanup)

        self.status_timer = QTimer(self.app)
        self.status_timer.setInterval(3500)
        self.status_timer.timeout.connect(self.refresh_status)
        self.status_timer.start()
        self.activity_timer = QTimer(self.app)
        self.activity_timer.setInterval(500)
        self.activity_timer.timeout.connect(self.refresh_activity)
        self.activity_timer.start()
        self.refresh_status()

    def _add_disabled(self, label):
        item = self.menu.addAction(label)
        item.setEnabled(False)
        return item

    def accept_connections(self):
        while self.server.hasPendingConnections():
            socket = self.server.nextPendingConnection()
            if not socket.waitForReadyRead(300):
                socket.deleteLater()
                continue
            command = bytes(socket.readAll()).decode("ascii", "replace").strip()
            if command == "quit":
                socket.disconnectFromServer()
                socket.deleteLater()
                QTimer.singleShot(0, self.app.quit)
            elif command == "status":
                socket.write((self.last_state or "STARTING").encode("ascii") + b"\n")
                socket.flush()
                socket.waitForBytesWritten(300)
                socket.disconnectFromServer()
                socket.deleteLater()

    def cleanup(self):
        self.tray.hide()
        self.server.close()
        QLocalServer.removeServer(str(SOCKET_FILE))
        logging.info("Tray companion stopped")

    def _get(self, url, callback, *, method="GET", payload=None, timeout=2000):
        request = QNetworkRequest(QUrl(url))
        request.setTransferTimeout(timeout)
        if method == "POST":
            request.setHeader(QNetworkRequest.KnownHeaders.ContentTypeHeader, "application/json")
            request.setRawHeader(b"X-OpenClaw-Tray", b"1")
            reply = self.network.post(request, json.dumps(payload).encode("utf-8"))
        else:
            reply = self.network.get(request)

        def finished():
            result = None
            if reply.error() == QNetworkReply.NetworkError.NoError:
                raw = bytes(reply.readAll()).decode("utf-8", "replace").strip()
                try:
                    result = json.loads(raw)
                except (ValueError, TypeError):
                    result = raw
            reply.deleteLater()
            callback(result)

        reply.finished.connect(finished)

    def _reload_config(self):
        try:
            stat = CONFIG_FILE.stat()
            signature = (stat.st_mtime_ns, stat.st_size)
            if signature == self.config_signature and self.config:
                return
            candidate = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
            for key in ("gatewayPort", "bridgePort", "tunnelHealthPort"):
                value = candidate.get(key)
                if isinstance(value, bool) or not str(value).isdigit() or not 1 <= int(value) <= 65535:
                    raise ValueError("Invalid local port: " + key)
            self.config = candidate
            self.config_signature = signature
            self.monitor_url = f"http://127.0.0.1:{int(candidate['bridgePort'])}/monitor"
            logging.info("Loaded or reloaded local configuration")
        except (OSError, ValueError, TypeError, KeyError) as exc:
            if self.config is not None:
                logging.warning("Local configuration unavailable: %s", exc)
            self.config = None
            self.config_signature = None
            self.monitor_url = None

    def refresh_status(self):
        if self.status_in_flight:
            return
        self._reload_config()
        if self.config is None:
            self.update_state("CONFIG MISSING", {"Configured": False, "Gateway": False, "Bridge": False, "Tunnel": False})
            self.ready_was_shown = False
            return
        self.status_in_flight = True
        ports = self.config
        probes = {
            "Gateway": f"http://127.0.0.1:{int(ports['gatewayPort'])}/startupz",
            "Bridge": f"http://127.0.0.1:{int(ports['bridgePort'])}/healthz",
            "Tunnel": f"http://127.0.0.1:{int(ports['tunnelHealthPort'])}/readyz",
        }
        components = {"Configured": True, "Gateway": False, "Bridge": False, "Tunnel": False}
        remaining = set(probes)

        def on_result(name, value):
            if name == "Gateway":
                components[name] = isinstance(value, dict) and value.get("ok") is True and value.get("status") == "started"
            elif name == "Bridge":
                components[name] = isinstance(value, dict) and value.get("ok") is True and value.get("server") == "openclaw-chatgpt-bridge"
            else:
                components[name] = value == "ready" or (isinstance(value, dict) and value.get("status") == "ready")
            remaining.discard(name)
            if not remaining:
                self.status_in_flight = False
                now = time.monotonic()
                state = classify_status(components, ever_ready=self.ever_ready,
                                        startup_grace_until=self.startup_grace_until,
                                        restart_until=self.restart_until, now=now)
                if state == "READY":
                    self.ever_ready = True
                    self.restart_until = 0
                self.update_state(state, components)
                if state == "READY" and not self.ready_was_shown:
                    self.tray.showMessage(APP_NAME + " is ready",
                                          "Gateway, MCP Bridge and Secure MCP Tunnel are all healthy.",
                                          QSystemTrayIcon.MessageIcon.Information, 3500)
                self.ready_was_shown = state == "READY"

        for name, url in probes.items():
            self._get(url, lambda value, name=name: on_result(name, value))

    def update_icon(self):
        kind = self.base_icon
        description = self.last_state or "STARTING"
        if self.activity_icon == "Computer":
            kind, description = "Computer", "Computer in use"
        elif self.activity_icon == "Tool":
            kind, description = "Tool", "Tool call running"
        self.tray.setIcon(self.icons[kind])
        self.tray.setToolTip(APP_NAME + ": " + description)

    def update_state(self, state, components):
        self.base_icon = "Ready" if state == "READY" else "Offline" if state in ("OFFLINE", "CONFIG MISSING") else "Pending"
        self.bridge_available = bool(components["Configured"] and components["Bridge"])
        if not self.bridge_available:
            self.activity_icon = None
        if state != self.last_state:
            logging.info("State changed: %s; components=%s", state, components)
            self.last_state = state
        self.update_icon()
        self.state_item.setText("Status: " + state)
        self.gateway_item.setText("Gateway: " + ("Started" if components["Gateway"] else "Not ready" if components["Configured"] else "Unknown"))
        self.bridge_item.setText("MCP Bridge: " + ("Healthy" if components["Bridge"] else "Not ready" if components["Configured"] else "Unknown"))
        self.tunnel_item.setText("Secure MCP Tunnel: " + ("Ready" if components["Tunnel"] else "Not ready" if components["Configured"] else "Unknown"))
        self.restart_item.setEnabled(time.monotonic() >= self.restart_until)
        self.cursor_item.setEnabled(self.bridge_available)

    def refresh_activity(self):
        if not self.bridge_available or self.activity_in_flight or self.config is None:
            return
        self.activity_in_flight = True
        bridge_port = int(self.config["bridgePort"])

        def on_activity(value):
            self.activity_in_flight = False
            if not self.bridge_available or not isinstance(value, dict):
                return
            kind = "Computer" if int(value.get("computerCount") or 0) > 0 else "Tool" if int(value.get("activeCount") or 0) > 0 else None
            if kind != self.activity_icon:
                self.activity_icon = kind
                self.update_icon()
                logging.info("Activity changed: %s", kind or "Idle")

        self._get(f"http://127.0.0.1:{bridge_port}/api/activity", on_activity, timeout=1250)

    def refresh_cursor(self):
        if not self.bridge_available or self.config is None:
            self.cursor_item.setEnabled(False)
            return
        self.cursor_item.setEnabled(False)
        bridge_port = int(self.config["bridgePort"])

        def on_cursor(value):
            if isinstance(value, dict) and value.get("ok") is True:
                self.cursor_item.setChecked(bool(value.get("enabled")))
                self.cursor_item.setEnabled(self.bridge_available)

        self._get(f"http://127.0.0.1:{bridge_port}/api/browser-cursor", on_cursor)

    def set_cursor(self, checked):
        if not self.bridge_available or self.config is None:
            self.cursor_item.setChecked(not checked)
            return
        self.cursor_item.setEnabled(False)
        port = int(self.config["bridgePort"])

        def on_result(value):
            if not isinstance(value, dict) or value.get("ok") is not True or value.get("enabled") is not checked:
                self.cursor_item.setChecked(not checked)
                self.tray.showMessage(APP_NAME, "Could not change AI Cursor setting.", QSystemTrayIcon.MessageIcon.Warning)
                logging.warning("Could not change AI Cursor setting")
            else:
                logging.info("AI Cursor visibility changed: %s", checked)
            self.cursor_item.setEnabled(self.bridge_available)

        self._get(f"http://127.0.0.1:{port}/api/browser-cursor", on_result,
                  method="POST", payload={"enabled": checked}, timeout=7000)

    def open_monitor(self):
        if self.monitor_url:
            QDesktopServices.openUrl(QUrl(self.monitor_url))

    def on_tray_activated(self, reason):
        if reason == QSystemTrayIcon.ActivationReason.DoubleClick:
            self.open_monitor()

    def _run_systemctl(self, args, on_success):
        process = QProcess(self.app)
        self.operations.add(process)

        def finished(exit_code, status):
            self.operations.discard(process)
            if status == QProcess.ExitStatus.NormalExit and exit_code == 0:
                on_success()
            else:
                error = bytes(process.readAllStandardError()).decode("utf-8", "replace").strip()
                logging.error("systemctl %s failed: %s", args, error)
                self.tray.showMessage(APP_NAME, error or "systemctl operation failed", QSystemTrayIcon.MessageIcon.Warning)
                self.restart_until = 0
                self.stop_item.setEnabled(True)
                self.refresh_status()
            process.deleteLater()

        process.finished.connect(finished)
        process.setProgram("systemctl")
        process.setArguments(["--user", *args])
        process.start()

    def restart_bridge(self):
        if time.monotonic() < self.restart_until:
            return
        self.restart_until = time.monotonic() + 360
        self.update_state("RESTARTING", {"Configured": True, "Gateway": False, "Bridge": False, "Tunnel": False})
        self._run_systemctl(["restart", "openclaw-chatgpt-bridge.service"],
                            lambda: logging.info("Bridge restart requested from tray"))

    def stop_services(self):
        self.stop_item.setEnabled(False)
        self._run_systemctl(["stop", "openclaw-chatgpt-tunnel.service", "openclaw-chatgpt-bridge.service"],
                            self.app.quit)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--quit", action="store_true", help="Exit the running tray without stopping services")
    parser.add_argument("--status", action="store_true", help="Show current tray state")
    args = parser.parse_args()

    if args.quit or args.status:
        from PySide6.QtCore import QCoreApplication
        app = QCoreApplication(sys.argv)
        return 0 if send_control("status" if args.status else "quit") else 1

    LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(filename=LOG_FILE, level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    app = QApplication(sys.argv)
    app.setApplicationName(APP_NAME)
    app.setQuitOnLastWindowClosed(False)
    if not QSystemTrayIcon.isSystemTrayAvailable():
        logging.warning("System tray not yet available; Qt will retry when the host appears")
    try:
        companion = TrayCompanion(app)
    except RuntimeError as exc:
        if "already running" not in str(exc):
            logging.error("Tray startup failed: %s", exc)
            return 1
        return 0
    logging.info("Tray companion started")
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
