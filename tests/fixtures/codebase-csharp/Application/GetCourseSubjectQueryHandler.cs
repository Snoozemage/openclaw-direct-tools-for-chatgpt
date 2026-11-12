using MediatR;
namespace Sample.Application;
public class GetCourseSubjectQueryHandler : IRequestHandler<GetCourseSubjectQuery,object> {
  private readonly ICourseSubjectRepository _repo;
  public GetCourseSubjectQueryHandler(ICourseSubjectRepository repo) { _repo=repo; }
  public Task<object> Handle(GetCourseSubjectQuery request,CancellationToken ct) {
    return Task.FromResult<object>(_repo.GetById(request.Id));
  }
}
public class BatchUpdateDevicesCommandHandler : IRequestHandler<BatchUpdateDevicesCommand,object> {
  public Task<object> Handle(BatchUpdateDevicesCommand command,CancellationToken ct) {
    return Task.FromResult<object>(new {});
  }
}
