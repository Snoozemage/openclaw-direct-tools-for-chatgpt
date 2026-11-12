import test from "node:test";
import assert from "node:assert/strict";
import { extractPhpFacts, assertPhpParserReady } from "../src/tools/codebase-intelligence/php-parser.mjs";

const routes=String.raw`<?php
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\CourseDeviceController;
Route::prefix('admin')->middleware('auth')->group(function () {
    Route::get('/course-devices', [CourseDeviceController::class, 'index'])->name('device.index');
    Route::controller(CourseDeviceController::class)->prefix('course-books')->as('course-books.')->group(function () {
        Route::post('/phones/batch-update','batchUpdatePhone')->name('phones.batch-update');
    });
    Route::resource('course-devices', CourseDeviceController::class);
});
`;
const controller=String.raw`<?php
namespace App\Http\Controllers;
use App\Models\CourseSubject;
use Illuminate\Support\Facades\DB;
class CourseDeviceController {
  public function index() {
    return CourseSubject::query()->where('credit', 3)->get();
  }
  public function batchUpdatePhone() {
    return DB::table('course_subjects')->update(['allow_phone' => 1]);
  }
}
`;
const model=String.raw`<?php
namespace App\Models;
use Illuminate\Database\Eloquent\Model;
class CourseSubject extends Model {
  protected $table = 'course_subjects';
  protected $fillable = ['subject_code', 'credit', 'course_id', 'allow_phone'];
  public function course() { return $this->belongsTo(Course::class,'course_id'); }
}
`;
const migration=String.raw`<?php
use Illuminate\Support\Facades\Schema;
use Illuminate\Database\Schema\Blueprint;
Schema::create('course_subjects',function(Blueprint $table){
  $table->id();
  $table->integer('credit');
  $table->unsignedBigInteger('course_id');
});
`;

test("standalone PHP AST parser is available without loading legacy vendor code", async () => {
  await assertPhpParserReady();
});
test("extracts Laravel nested route prefix, controller group, named route and resource convention", async () => {
  const r=await extractPhpFacts({relativePath:"routes/web.php",source:routes});
  assert.equal(r.parseError,null);
  const facts=r.facts.filter((f)=>f.kind==="route");
  assert.ok(facts.some((f)=>f.name==="GET /admin/course-devices" && f.target==="App\\Http\\Controllers\\CourseDeviceController@index"));
  assert.ok(facts.some((f)=>f.name==="POST /admin/course-books/phones/batch-update" && f.target==="App\\Http\\Controllers\\CourseDeviceController@batchUpdatePhone" && f.details.routeName==="course-books.phones.batch-update"));
  assert.ok(facts.some((f)=>f.details.resourceConvention===true && f.status==="inferred"));
});
test("extracts PHP controllers, model Eloquent relations, fillable fields and migrations", async () => {
  const c=await extractPhpFacts({relativePath:"app/Http/Controllers/CourseDeviceController.php",source:controller});
  const m=await extractPhpFacts({relativePath:"app/Models/CourseSubject.php",source:model});
  const db=await extractPhpFacts({relativePath:"database/migrations/2026_create_course_subjects.php",source:migration});
  assert.equal(c.parseError,null);
  assert.equal(m.parseError,null);
  assert.equal(db.parseError,null);
  assert.ok(c.facts.some((x)=>x.kind==="method" && x.name==="App\\Http\\Controllers\\CourseDeviceController@index"));
  assert.ok(c.facts.some((x)=>x.kind==="static_call" && x.target==="App\\Models\\CourseSubject@query"));
  assert.ok(c.facts.some((x)=>x.kind==="table_access" && x.target==="course_subjects"));
  assert.ok(c.facts.some((x)=>x.kind==="table_access" && x.target==="course_subjects" &&
    x.details.operation==="update" && x.details.dataAction==="write" && x.status==="inferred"));
  assert.ok(m.facts.some((x)=>x.kind==="model_field" && x.name==="credit"));
  assert.ok(m.facts.some((x)=>x.kind==="eloquent_relation" && x.target==="App\\Models\\Course"));
  assert.ok(db.facts.some((x)=>x.kind==="migration_table" && x.target==="course_subjects" && x.details.columns.includes("credit")));
});
test("syntax failures are explicit and never turn into fake verified facts", async () => {
  const r=await extractPhpFacts({relativePath:"routes/broken.php",source:"<?php if ("});
  assert.ok(r.parseError);
  assert.deepEqual(r.facts,[]);
});
