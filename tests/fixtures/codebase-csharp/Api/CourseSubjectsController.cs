using MediatR;
using Microsoft.AspNetCore.Mvc;
namespace Sample.Api;
[ApiController]
[Route("api/[controller]")]
public sealed class CourseSubjectsController(IMediator mediator) : ControllerBase {
  [HttpGet("{id}")]
  public async Task<object> GetById(Guid id) {
    return await mediator.Send(new GetCourseSubjectQuery(id));
  }
  [HttpPost("batch-update")]
  public async Task<object> BatchUpdate([FromBody] BatchUpdateDevicesDto request) {
    var command = new BatchUpdateDevicesCommand(request.CourseId);
    return await mediator.Send(command);
  }
}
