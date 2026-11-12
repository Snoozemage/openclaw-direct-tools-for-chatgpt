import {coursesService} from '@/services/courses.service';
export default function Page(){ return <button onClick={()=>coursesService.getAll()}>Subjects</button> }
