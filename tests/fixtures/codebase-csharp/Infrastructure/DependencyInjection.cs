using Microsoft.Extensions.DependencyInjection;
namespace Sample.Infrastructure;
public static class DependencyInjection {
 public static void AddStuff(IServiceCollection services) {
  services.AddScoped<ICourseSubjectRepository,CourseSubjectRepository>();
  services.AddDbContext<SampleDbContext>();
 }
}
