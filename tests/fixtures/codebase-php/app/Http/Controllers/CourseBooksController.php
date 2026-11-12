<?php
namespace App\Http\Controllers;
use App\Models\CourseSubject;
use Illuminate\Support\Facades\DB;
class CourseBooksController {
  public function phoneIndex() {
    $subjects = CourseSubject::where('allow_phone', 1)->get();
    return view('course_books.phones', ['subjects' => $subjects]);
  }
  public function batchUpdatePhone() {
    return DB::table('course_subjects')->where('credit', '>', 0)->update(['allow_phone'=>1]);
  }
}
