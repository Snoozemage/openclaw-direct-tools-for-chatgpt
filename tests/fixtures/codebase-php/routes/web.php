<?php
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\CourseBooksController;
Route::middleware('auth')->prefix('admin')->name('admin.')->group(function() {
    Route::controller(CourseBooksController::class)->prefix('course-books')->as('course-books.')->group(function() {
        Route::get('/phones', 'phoneIndex')->name('phones');
        Route::post('/phones/batch-update', 'batchUpdatePhone')->name('phones.batch-update');
    });
    Route::resource('course-subjects', CourseBooksController::class);
});
