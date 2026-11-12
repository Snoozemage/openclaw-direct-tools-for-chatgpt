import {axiosInstance} from '@/services/api';
export const coursesService={
  getById: (id:string)=>axiosInstance.get('/api/CourseSubjects/'+id),
  getAll: ()=>axiosInstance.get('/api/course-subjects'),
  raw: async ()=>fetch('/api/CourseSubjects/{id}',{method:'GET'})
};
