import {teachingDevicesService} from '@/services/teaching-devices.service';
import {Button} from '@/components/ui/button';
export default function TeachingDevicesView(){
  const list = () => teachingDevicesService.list({});
  return <button onClick={list}>Devices</button>;
}
