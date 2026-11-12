import axios from 'axios';
import {envConfig} from '@/configs/env.config';
export const axiosInstance=axios.create({baseURL:envConfig.apiUrl});
