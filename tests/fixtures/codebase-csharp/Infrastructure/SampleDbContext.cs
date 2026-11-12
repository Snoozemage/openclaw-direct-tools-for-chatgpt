using Microsoft.EntityFrameworkCore;
namespace Sample.Infrastructure;
public class SampleDbContext : DbContext {
 public DbSet<CourseSubject> CourseSubjects => Set<CourseSubject>();
}
public class CourseSubject {public Guid Id {get;set;} public int Credit {get;set;}}
