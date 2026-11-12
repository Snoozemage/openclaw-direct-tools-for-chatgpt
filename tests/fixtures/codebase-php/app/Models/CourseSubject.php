<?php
namespace App\Models;
use Illuminate\Database\Eloquent\Model;
class CourseSubject extends Model {
  protected $table = 'course_subjects';
  protected $fillable = ['credit','course_id','subject_code','allow_phone'];
  public function course() {
    return $this->belongsTo(Course::class, 'course_id');
  }
}
