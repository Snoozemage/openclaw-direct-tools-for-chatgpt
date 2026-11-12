<?php
use Illuminate\Support\Facades\Schema;
use Illuminate\Database\Schema\Blueprint;
Schema::create('course_subjects',function(Blueprint $table) {
  $table->id();
  $table->integer('credit');
  $table->unsignedBigInteger('course_id');
});
