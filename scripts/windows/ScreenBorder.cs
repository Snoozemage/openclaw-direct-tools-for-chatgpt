using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace OpenClawScreenBorder {
    internal static class Native {
        [StructLayout(LayoutKind.Sequential)] internal struct Point { public int X, Y; public Point(int x, int y) { X=x; Y=y; } }
        [StructLayout(LayoutKind.Sequential)] internal struct Size { public int Width, Height; public Size(int w,int h) { Width=w; Height=h; } }
        [StructLayout(LayoutKind.Sequential, Pack=1)] internal struct Blend { public byte Operation, Flags, Alpha, Format; }
        [DllImport("user32.dll")] internal static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] internal static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] internal static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] internal static extern IntPtr GetDC(IntPtr window);
        [DllImport("user32.dll")] internal static extern int ReleaseDC(IntPtr window,IntPtr dc);
        [DllImport("gdi32.dll")] internal static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] internal static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")] internal static extern IntPtr SelectObject(IntPtr dc,IntPtr value);
        [DllImport("gdi32.dll")] internal static extern bool DeleteObject(IntPtr value);
        [DllImport("user32.dll",SetLastError=true)] internal static extern bool SetWindowDisplayAffinity(IntPtr window,uint affinity);
        [DllImport("user32.dll",SetLastError=true)] internal static extern bool UpdateLayeredWindow(IntPtr window,IntPtr screen,ref Point destination,ref Size size,IntPtr source,ref Point origin,int key,ref Blend blend,uint flags);
    }

    internal sealed class Edge : Form {
        private readonly int side;
        private readonly Rectangle requestedBounds;
        public bool CaptureExcluded { get; private set; }
        public Edge(Rectangle bounds,int edge,bool excludeCapture) {
            side=edge;
            requestedBounds=bounds;
            FormBorderStyle=FormBorderStyle.None;
            ShowInTaskbar=false;
            TopMost=true;
            StartPosition=FormStartPosition.Manual;
            Bounds=bounds;
            Text="OpenClaw computer border";
            // Creating the handle does not activate the window.
            IntPtr handle=Handle;
            CaptureExcluded=excludeCapture && Native.SetWindowDisplayAffinity(handle,0x11);
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override CreateParams CreateParams {
            get {
                CreateParams value=base.CreateParams;
                // Layered, click-through, tool window, and never activate.
                value.ExStyle |= 0x00080000 | 0x00000020 | 0x00000080 | 0x08000000;
                return value;
            }
        }
        protected override void WndProc(ref Message message) {
            if (message.Msg==0x84) { message.Result=new IntPtr(-1); return; }
            if (message.Msg==0x21) { message.Result=new IntPtr(3); return; }
            base.WndProc(ref message);
        }
        public void Display() {
            Show();
            // WinForms can enlarge a requested ten-pixel strip to its native
            // minimum (sixteen pixels here). Anchor the actual outer edge,
            // otherwise the right/bottom glow is painted beyond the display.
            Location=new System.Drawing.Point(
                side==3 ? requestedBounds.Right-Width : requestedBounds.Left,
                side==1 ? requestedBounds.Bottom-Height : requestedBounds.Top);
            using (Bitmap bitmap=new Bitmap(Width,Height,PixelFormat.Format32bppArgb)) {
                using (Graphics g=Graphics.FromImage(bitmap)) {
                    g.Clear(Color.Transparent);
                    int thickness=(side<2 ? Height : Width);
                    for (int distance=0;distance<thickness;distance++) {
                        int alpha=distance<2 ? 235 : (int)(150*Math.Pow(1.0-(double)distance/thickness,2));
                        using (Pen pen=new Pen(Color.FromArgb(alpha,167,139,250))) {
                            if (side==0) g.DrawLine(pen,0,distance,Width,distance);
                            else if (side==1) g.DrawLine(pen,0,Height-1-distance,Width,Height-1-distance);
                            else if (side==2) g.DrawLine(pen,distance,0,distance,Height);
                            else g.DrawLine(pen,Width-1-distance,0,Width-1-distance,Height);
                        }
                    }
                }
                IntPtr screen=Native.GetDC(IntPtr.Zero);
                IntPtr memory=Native.CreateCompatibleDC(screen);
                IntPtr bits=bitmap.GetHbitmap(Color.FromArgb(0));
                IntPtr previous=Native.SelectObject(memory,bits);
                try {
                    Native.Point destination=new Native.Point(Left,Top),origin=new Native.Point(0,0);
                    Native.Size size=new Native.Size(Width,Height);
                    Native.Blend blend=new Native.Blend { Operation=0,Flags=0,Alpha=255,Format=1 };
                    if (!Native.UpdateLayeredWindow(Handle,screen,ref destination,ref size,memory,ref origin,0,ref blend,2))
                        throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                } finally {
                    Native.SelectObject(memory,previous);
                    Native.DeleteObject(bits);
                    Native.DeleteDC(memory);
                    Native.ReleaseDC(IntPtr.Zero,screen);
                }
            }
        }
    }

    public static class Host {
        private static long lastHeartbeat;
        private static volatile bool stopped;
        private static volatile bool active;
        public static void Run(int parentProcessId,bool excludeCapture) {
            try { Native.SetProcessDpiAwarenessContext(new IntPtr(-4)); }
            catch (EntryPointNotFoundException) { Native.SetProcessDPIAware(); }
            lastHeartbeat=DateTime.UtcNow.Ticks;
            stopped=false;
            active=false;
            Thread reader=new Thread(delegate() {
                try {
                    string line;
                    while ((line=Console.ReadLine())!=null) {
                        if (line=="stop") break;
                        if (line=="active") {
                            Interlocked.Exchange(ref lastHeartbeat,DateTime.UtcNow.Ticks);
                            active=true;
                        }
                    }
                } finally { stopped=true; }
            });
            reader.IsBackground=true;
            reader.Start();
            List<Edge> windows=new List<Edge>();
            ApplicationContext context=new ApplicationContext();
            IntPtr foreground=Native.GetForegroundWindow();
            string geometry="";
            Action refresh=delegate() {
                string next="";
                foreach (Screen screen in Screen.AllScreens) next+=screen.Bounds.ToString();
                if (next==geometry) return;
                foreach (Edge window in windows) window.Dispose();
                windows.Clear();
                geometry=next;
                int excluded=0;
                foreach (Screen screen in Screen.AllScreens) {
                    Rectangle b=screen.Bounds;
                    int width=Math.Min(10,Math.Min(b.Width,b.Height)/4);
                    Rectangle[] edges={
                        new Rectangle(b.Left,b.Top,b.Width,width),
                        new Rectangle(b.Left,b.Bottom-width,b.Width,width),
                        new Rectangle(b.Left,b.Top+width,width,b.Height-2*width),
                        new Rectangle(b.Right-width,b.Top+width,width,b.Height-2*width)
                    };
                    for (int side=0;side<4;side++) {
                        Edge window=new Edge(edges[side],side,excludeCapture);
                        windows.Add(window);
                        window.Display();
                        if (window.CaptureExcluded) excluded++;
                    }
                }
                Console.WriteLine("{\"event\":\"ready\",\"windowCount\":"+windows.Count+
                    ",\"monitorCount\":"+Screen.AllScreens.Length+",\"captureExcludedCount\":"+excluded+
                    ",\"clickThrough\":true,\"nonActivating\":true,\"foregroundUnchanged\":"+
                    (foreground==Native.GetForegroundWindow() ? "true":"false")+"}");
                Console.Out.Flush();
            };
            System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer();
            timer.Interval=250;
            timer.Tick+=delegate {
                bool parentAlive;
                try { using (Process parent=Process.GetProcessById(parentProcessId)) parentAlive=!parent.HasExited; }
                catch (ArgumentException) { parentAlive=false; }
                if (stopped || !parentAlive || DateTime.UtcNow.Ticks-Interlocked.Read(ref lastHeartbeat)>TimeSpan.FromSeconds(6).Ticks)
                    context.ExitThread();
                else if (active) {
                    try { refresh(); }
                    catch (Exception error) { Console.Error.WriteLine(error.Message); context.ExitThread(); }
                }
            };
            try {
                timer.Start();
                Application.Run(context);
            } finally {
                timer.Stop();
                timer.Dispose();
                foreach (Edge window in windows) window.Dispose();
                context.Dispose();
            }
        }
    }
}
