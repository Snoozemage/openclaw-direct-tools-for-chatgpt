using Microsoft.EntityFrameworkCore;
namespace Sample.Infrastructure;
public class CourseSubjectConfiguration : IEntityTypeConfiguration<CourseSubject> {
 public void Configure(EntityTypeBuilder<CourseSubject> builder){
  builder.ToTable("course_subjects");
  builder.Property(x=>x.Credit).HasColumnName("credit");
 }
}
