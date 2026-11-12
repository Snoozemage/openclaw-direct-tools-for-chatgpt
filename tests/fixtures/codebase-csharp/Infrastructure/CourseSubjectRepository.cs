namespace Sample.Infrastructure;
public class CourseSubjectRepository : ICourseSubjectRepository {
  private readonly SampleDbContext _db;
  public CourseSubjectRepository(SampleDbContext db){_db=db;}
  public object GetById(Guid id){return _db.CourseSubjects.First();}
  public void RefreshCredits(){_db.Database.ExecuteSqlRaw("UPDATE course_subjects SET credit=1");}
}
