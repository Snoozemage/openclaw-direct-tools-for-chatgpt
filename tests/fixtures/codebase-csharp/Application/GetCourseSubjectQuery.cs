using MediatR;
namespace Sample.Application;
public record GetCourseSubjectQuery(Guid Id) : IRequest<object>;
public record BatchUpdateDevicesCommand(Guid CourseId) : IRequest<object>;
