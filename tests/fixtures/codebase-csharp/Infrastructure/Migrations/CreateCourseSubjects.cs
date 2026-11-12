using Microsoft.EntityFrameworkCore.Migrations;
namespace Sample.Infrastructure.Migrations;
public class CreateCourseSubjects : Migration {
 protected override void Up(MigrationBuilder migrationBuilder) {
  migrationBuilder.CreateTable(name: "course_subjects",
    columns: table => new { id = table.Column<System.Guid>(nullable: false) });
  migrationBuilder.AddColumn<int>(name: "credit", table: "course_subjects");
 }
}
