using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

record InputFile(string RelativePath, string Code);
record InputRequest(int Version, List<InputFile> Files);
record Fact(string Kind, string Name, string? Parent, string? Target, int StartLine, int EndLine,
  string Status, object Details);
record OutputFile(string RelativePath, List<Fact> Facts, string? ParseError);
record OutputResponse(bool Ok, string Parser, List<OutputFile> Files);

static class Program {
  const int MaxFiles = 36, MaxFacts = 2400, MaxInputChars = 12000000;
  static readonly string[] HttpNames = ["HttpGet","HttpPost","HttpPut","HttpPatch","HttpDelete","HttpHead","HttpOptions"];
  static readonly string[] DiNames = ["AddScoped","AddSingleton","AddTransient"];
  static readonly JsonSerializerOptions JsonOpts = new() { PropertyNameCaseInsensitive=true, PropertyNamingPolicy=JsonNamingPolicy.CamelCase, DefaultIgnoreCondition=JsonIgnoreCondition.WhenWritingNull };

  static int Start(SyntaxNode n) => n.GetLocation().GetLineSpan().StartLinePosition.Line + 1;
  static int End(SyntaxNode n) => n.GetLocation().GetLineSpan().EndLinePosition.Line + 1;
  static string Simple(string type) => type.Split('.').Last().Split('<')[0].Trim().TrimStart('@');
  static string? Str(ExpressionSyntax? n) =>
      n is LiteralExpressionSyntax l && l.IsKind(SyntaxKind.StringLiteralExpression) ? l.Token.ValueText : null;
  static string? Arg(AttributeSyntax a) => Str(a.ArgumentList?.Arguments.FirstOrDefault()?.Expression);
  static bool Attr(AttributeSyntax a,string name) => Simple(a.Name.ToString()).TrimEnd("Attribute".ToCharArray()) == name ||
     Simple(a.Name.ToString()) == name || Simple(a.Name.ToString()) == name+"Attribute";
  static string Ns(SyntaxNode n) => string.Join(".",n.Ancestors().OfType<BaseNamespaceDeclarationSyntax>()
    .Reverse().Select(x=>x.Name.ToString()));
  static string Qualified(SyntaxNode n,string type) {var ns=Ns(n);return string.IsNullOrEmpty(ns)?type:ns+"."+type;}
  static IEnumerable<AttributeSyntax> Attributes(MemberDeclarationSyntax d) =>
    d.AttributeLists.SelectMany(x=>x.Attributes);
  static string? FmtRoute(string? value,string controller,string method,out bool inferred) {
    inferred=false;
    if(value==null)return null;
    if(value.Contains('[',StringComparison.Ordinal))inferred=true;
    var c=controller.EndsWith("Controller")?controller[..^10]:controller;
    return value.Replace("[controller]",c,StringComparison.OrdinalIgnoreCase)
      .Replace("[action]",method,StringComparison.OrdinalIgnoreCase).Replace("//","/").Trim('/');
  }
  static string JoinRoutes(string a,string b) =>
    (a+"/"+b).Split('/',StringSplitOptions.RemoveEmptyEntries).Aggregate("",(acc,s)=>acc+"/"+s) is string r
      ? (r.Length==0?"/":r) : "/";
  static object Detail(params (string key,object? value)[] pairs) =>
      pairs.Where(x=>x.value!=null).ToDictionary(x=>x.key,x=>x.value);
  static string? GenericArg(TypeSyntax type,int position=0) =>
    type switch {
      GenericNameSyntax g when g.TypeArgumentList.Arguments.Count>position => g.TypeArgumentList.Arguments[position].ToString(),
      QualifiedNameSyntax q => GenericArg(q.Right,position),
      AliasQualifiedNameSyntax a => GenericArg(a.Name,position),
      _ => null
    };
  static string BaseSimple(BaseTypeSyntax b) => Simple(b.Type.ToString());
  static string? TypedNew(ExpressionSyntax expression) =>
    expression is ObjectCreationExpressionSyntax o ? o.Type.ToString() :
    expression is ImplicitObjectCreationExpressionSyntax ? null :
    expression is CastExpressionSyntax c ? c.Type.ToString() :
    null;

  static OutputFile Parse(InputFile file, CSharpSyntaxTree tree, SemanticModel semantic) {
    var facts = new List<Fact>();
    void Add(string kind,string name,SyntaxNode node,string? parent=null,string? target=null,string status="verified_static",object? details=null) {
      if(facts.Count>=MaxFacts)return;
      facts.Add(new(kind,name,parent,target,Start(node),Math.Max(Start(node),End(node)),status,details??new{}));
    }
    var syntaxError=tree.GetDiagnostics().FirstOrDefault(d=>d.Severity==DiagnosticSeverity.Error);
    if(syntaxError is not null) {
      var span=syntaxError.Location.GetLineSpan().StartLinePosition;
      var sourceText=tree.GetText();
      var offset=syntaxError.Location.SourceSpan.Start;
      var symbol=offset>=0 && offset<sourceText.Length ? ((int)sourceText[offset]).ToString("X4") : "none";
      return new(file.RelativePath,[], "CS_SYNTAX_ERROR:"+syntaxError.Id+"@"+
        (span.Line+1)+":"+(span.Character+1)+":U+"+symbol);
    }
    var root=tree.GetCompilationUnitRoot();
    foreach(var d in root.DescendantNodes().OfType<BaseTypeDeclarationSyntax>()) {
      if(d.Parent is not (NamespaceDeclarationSyntax or FileScopedNamespaceDeclarationSyntax or CompilationUnitSyntax)) continue;
      string name=d.Identifier.Text,fq=Qualified(d,name);
      var kind=d switch { InterfaceDeclarationSyntax=>"interface",RecordDeclarationSyntax=>"record",
        StructDeclarationSyntax=>"struct",_=>"class" };
      ISymbol? semanticSymbol=semantic.GetDeclaredSymbol(d);
      Add(kind,fq,d,details:Detail(("name",name),("semanticDeclaredSymbol",semanticSymbol?.ToDisplayString()),
        ("semanticResolved",semanticSymbol!=null)));
      var bases=d.BaseList?.Types.ToList()??[];
      bool isController=name.EndsWith("Controller")||bases.Any(b=>BaseSimple(b) is "ControllerBase" or "Controller");
      bool isContext=bases.Any(b=>BaseSimple(b)=="DbContext");
      var attrs=Attributes(d).ToList();
      var controllerRoute=attrs.Where(a=>Attr(a,"Route")).Select(Arg).FirstOrDefault(x=>x!=null);
      if(isController) Add("controller",fq,d,details:Detail(("routeTemplate",controllerRoute),("base",bases.Select(x=>x.Type.ToString()).ToArray())));
      if(isContext)Add("ef_context",fq,d);
      bool isDto=name.EndsWith("Dto",StringComparison.Ordinal)||name.EndsWith("Request",StringComparison.Ordinal)||name.EndsWith("Response",StringComparison.Ordinal);
      if(isDto)Add("dto",fq,d,details:Detail(("type",kind)));
      if(name.EndsWith("Service",StringComparison.Ordinal)||name.EndsWith("Repository",StringComparison.Ordinal))
        Add("service",fq,d,details:Detail(("symbolKind",kind)));
      var handlerBases=bases.Where(b=>BaseSimple(b)=="IRequestHandler").ToList();
      foreach(var b in handlerBases) {
        var request=GenericArg(b.Type);
        if(request!=null)Add("cqrs_handler",fq,b,parent:fq,target:request,details:Detail(("requestType",request),
          ("handlerInterface",b.Type.ToString())));
      }
      foreach(var b in bases.Where(b=>BaseSimple(b) is "IRequest" or "INotification")) {
        Add("cqrs_request",fq,b,parent:fq,details:Detail(("requestInterface",b.Type.ToString())));
      }
      if(d is not TypeDeclarationSyntax t)continue;
      if(isDto && d is RecordDeclarationSyntax dtoRecord && dtoRecord.ParameterList is not null)
        foreach(var param in dtoRecord.ParameterList.Parameters)
          Add("dto_field",fq+"."+param.Identifier.Text,param,parent:fq,target:param.Type?.ToString(),
            details:Detail(("parameter",true)));
      foreach(var prop in t.Members.OfType<PropertyDeclarationSyntax>()) {
        var type=prop.Type.ToString();
        var entity=GenericArg(prop.Type);
        if(isContext && Simple(type)=="DbSet" && entity!=null)
          Add("ef_dbset",fq+"."+prop.Identifier.Text,prop,parent:fq,target:entity,
            details:Detail(("entity",entity),("property",prop.Identifier.Text)));
        if(isDto)Add("dto_field",fq+"."+prop.Identifier.Text,prop,parent:fq,target:type,
          details:Detail(("property",prop.Identifier.Text)));
        else if(type.EndsWith("Dto",StringComparison.Ordinal)||type.Contains("Request",StringComparison.Ordinal))
          Add("dto_property",fq+"."+prop.Identifier.Text,prop,parent:fq,
            details:Detail(("type",type)));
      }
      if(d is ClassDeclarationSyntax primary && primary.ParameterList is not null) {
        foreach(var parameter in primary.ParameterList.Parameters) {
          var serviceType=parameter.Type?.ToString();
          if(serviceType!=null) Add("constructor_dependency",fq+"."+parameter.Identifier.Text,parameter,
            parent:fq,target:serviceType,details:Detail(("serviceType",serviceType),("primaryConstructor",true)));
        }
      }
      foreach(var constructor in t.Members.OfType<ConstructorDeclarationSyntax>()) {
        foreach(var param in constructor.ParameterList.Parameters) {
          var type=param.Type?.ToString();
          if(type!=null)Add("constructor_dependency",fq+"."+param.Identifier.Text, param,
             parent:fq,target:type,details:Detail(("serviceType",type),("parameter",param.Identifier.Text)));
        }
      }
      foreach(var method in t.Members.OfType<MethodDeclarationSyntax>()) {
        string id=fq+"@"+method.Identifier.Text;
        Add("method",id,method,parent:fq,details:Detail(("returnType",method.ReturnType.ToString())));
        if(isController) {
          Add("controller_method",id,method,parent:fq,
            details:Detail(("parameters",method.ParameterList.Parameters.Select(p=>
              new {name=p.Identifier.Text,type=p.Type?.ToString()}).ToArray())));
          foreach(var param in method.ParameterList.Parameters){
            var type=param.Type?.ToString();
            if(type!=null && (type.EndsWith("Dto",StringComparison.Ordinal)||type.EndsWith("Request",StringComparison.Ordinal)))
              Add("method_parameter",id+"."+param.Identifier.Text,param,parent:id,target:type,
                details:Detail(("name",param.Identifier.Text),("type",type)));
          }
          var methodAttrs=Attributes(method).ToList();
          var baseRoute=controllerRoute??"";
          var subRoute=methodAttrs.Where(a=>Attr(a,"Route")).Select(Arg).FirstOrDefault(x=>x!=null);
          foreach(var attr in methodAttrs.Where(a=>HttpNames.Any(x=>Attr(a,x)))) {
            var verb=HttpNames.First(x=>Attr(attr,x)).Replace("Http","").ToUpperInvariant();
            var suffix=Arg(attr)??subRoute??"";
            var basePath=FmtRoute(baseRoute,name,method.Identifier.Text,out var inferredBase);
            var subPath=FmtRoute(suffix,name,method.Identifier.Text,out var inferredSub);
            if(basePath==null||subPath==null)continue;
            var uri=JoinRoutes(basePath,subPath);
            Add("endpoint",verb+" "+uri,attr,parent:id,target:id,
              status:(inferredBase||inferredSub)?"inferred":"verified_static",
              details:Detail(("httpMethod",verb),("uri",uri),("controller",fq),
                ("method",method.Identifier.Text),("routeTemplate",controllerRoute),("parameterTypes",
                  method.ParameterList.Parameters.Select(p=>p.Type?.ToString()).Where(x=>x!=null).ToArray())));
          }
        }
        var localTypes = new Dictionary<string,string>(StringComparer.Ordinal);
        foreach(var variable in method.DescendantNodes().OfType<VariableDeclaratorSyntax>()) {
          var v=variable.Initializer?.Value;
          if(v!=null) {
            var typ=TypedNew(v);
            if(typ!=null)localTypes[variable.Identifier.Text]=typ;
          }
        }
        foreach(var inv in method.DescendantNodes().OfType<InvocationExpressionSyntax>()) {
          if(inv.Expression is MemberAccessExpressionSyntax ma) {
            var invoked=ma.Name.Identifier.Text;
            if(invoked is "FromSqlRaw" or "ExecuteSqlRaw" or "FromSqlInterpolated" or "ExecuteSqlInterpolated" or "SqlQueryRaw") {
              var sql=inv.ArgumentList.Arguments.Count>0?Str(inv.ArgumentList.Arguments[0].Expression):null;
              string? table=null;
              if(sql!=null){
                var matched=System.Text.RegularExpressions.Regex.Match(sql,@"\b(?:FROM|JOIN|UPDATE|INTO)\s+([A-Za-z_][A-Za-z0-9_.]*)",
                  System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                if(matched.Success)table=matched.Groups[1].Value;
              }
              Add("sql_operation",id+" "+invoked,inv,parent:id,target:table,
                status:table==null?"unresolved":"inferred",
                details:Detail(("method",invoked),("tableCandidate",table),("staticLiteral",sql!=null)));
            }
            if(invoked=="Send" && inv.ArgumentList.Arguments.Count>0 && ma.Expression.ToString()
                .Contains("mediator",StringComparison.OrdinalIgnoreCase)) {
              var arg=inv.ArgumentList.Arguments[0].Expression;
              var req=TypedNew(arg)??(arg is IdentifierNameSyntax refName &&
                localTypes.TryGetValue(refName.Identifier.Text,out var known)?known:null);
              if(req!=null)Add("mediator_send",id+" -> "+req,inv,parent:id,target:req,
                status:"inferred",details:Detail(("messageType",req),("callSite",ma.Expression.ToString())));
              else Add("mediator_send",id+" -> ?",inv,parent:id,
                status:"unresolved",details:Detail(("argument",arg.ToString().Length<100?arg.ToString():"dynamic")));
            }
          }
        }
      }
      // EF IEntityTypeConfiguration<T>.ToTable("...") + Property(x=>x.Column) candidates.
      foreach(var b in bases.Where(b=>BaseSimple(b)=="IEntityTypeConfiguration")) {
        var ent=GenericArg(b.Type);
        if(ent==null)continue;
        Add("ef_configuration",fq,d,parent:fq,target:ent,details:Detail(("entityType",ent)));
        foreach(var inv in t.DescendantNodes().OfType<InvocationExpressionSyntax>()) {
          if(inv.Expression is not MemberAccessExpressionSyntax ma)continue;
          var nm=ma.Name.Identifier.Text;
          if(nm=="ToTable") {
            var tab=inv.ArgumentList.Arguments.Select(a=>Str(a.Expression)).FirstOrDefault(x=>x!=null);
            if(tab!=null)Add("ef_table",fq+" -> "+tab,inv,parent:fq,target:tab,
              details:Detail(("entity",ent),("table",tab)));
          }
          if(nm=="Property" && inv.ArgumentList.Arguments.Count>0){
            var arg=inv.ArgumentList.Arguments[0].Expression;
            var expr=arg is SimpleLambdaExpressionSyntax single?single.ExpressionBody:
              arg is ParenthesizedLambdaExpressionSyntax grouped?grouped.ExpressionBody:null;
            if(expr is MemberAccessExpressionSyntax prop){
              var column=prop.Name.Identifier.Text;
              Add("ef_property",fq+"."+column,inv,parent:fq,target:column,
                details:Detail(("entity",ent),("property",column)));
            }
          }
        }
      }
    }
    foreach(var inv in root.DescendantNodes().OfType<InvocationExpressionSyntax>()) {
      if(inv.Expression is not MemberAccessExpressionSyntax ma)continue;
      var method=ma.Name.Identifier.Text;
      if(ma.Expression.ToString()=="migrationBuilder" && method is "CreateTable" or "DropTable" or "AddColumn" or "AlterColumn" or "DropColumn" or "RenameTable"){
        string? Named(string argName)=>Str(inv.ArgumentList.Arguments.FirstOrDefault(a=>a.NameColon?.Name.Identifier.Text==argName)?.Expression);
        var name=Named("name")??(inv.ArgumentList.Arguments.Count>0?Str(inv.ArgumentList.Arguments[0].Expression):null);
        var table=method is "CreateTable" or "DropTable" or "RenameTable" ? name:Named("table");
        if(table!=null){
          var isColumn=method is "AddColumn" or "AlterColumn" or "DropColumn";
          Add(isColumn?"ef_migration_column":"ef_migration_table",
            isColumn?table+"."+(name??"?"):method+" "+table,inv,target:table,
            details:Detail(("operation",method),("table",table),("column",isColumn?name:null)));
        }
      }
      var gen=ma.Name as GenericNameSyntax;
      if(gen==null)continue;
      if(method=="AddDbContext" && gen.TypeArgumentList.Arguments.Count==1) {
        var ctx=gen.TypeArgumentList.Arguments[0].ToString();
        Add("ef_context_registration",ctx,inv,target:ctx,
          details:Detail(("contextType",ctx),("operation",method)));
        continue;
      }
      if(!DiNames.Contains(method))continue;
      if(gen.TypeArgumentList.Arguments.Count==1) {
        var factoryService=gen.TypeArgumentList.Arguments[0].ToString();
        Add("di_factory",factoryService+" -> runtime factory",inv,target:factoryService,status:"unresolved",
          details:Detail(("service",factoryService),("lifetime",method),("implementation","dynamic_factory")));
        continue;
      }
      if(gen.TypeArgumentList.Arguments.Count!=2)continue;
      var service=gen.TypeArgumentList.Arguments[0].ToString();
      var impl=gen.TypeArgumentList.Arguments[1].ToString();
      Add("di_registration",service+" -> "+impl,inv,target:impl,
        details:Detail(("service",service),("implementation",impl),("lifetime",method)));
    }
    return new(file.RelativePath,facts,null);
  }
  static async Task<int> Main() {
    try {
      // The Windows bridge may run with an OEM code page (CP437). stdin/stdout are UTF-8 JSON.
      Console.InputEncoding = System.Text.Encoding.UTF8;
      Console.OutputEncoding = new System.Text.UTF8Encoding(false);
      var raw=await Console.In.ReadToEndAsync();
      if(raw.Length>MaxInputChars)throw new InvalidOperationException("too_large");
      var request=JsonSerializer.Deserialize<InputRequest>(raw,JsonOpts);
      if(request?.Version!=1||request.Files is not {Count:>0 and <=MaxFiles})
        throw new InvalidOperationException("invalid_request");
      if(request.Files.Any(f=>f.Code.Length>2100000||f.RelativePath.Contains("..")||
            f.RelativePath.Length>1024||!f.RelativePath.EndsWith(".cs",StringComparison.OrdinalIgnoreCase)))
        throw new InvalidOperationException("invalid_path_or_source");
      // UTF-8 BOM is valid at the start of a C# file. ParseText(string) treats it as CS1056 unless removed.
      var trees=request.Files.Select(f=>(CSharpSyntaxTree)CSharpSyntaxTree.ParseText(f.Code.TrimStart('\uFEFF'),
        new CSharpParseOptions(LanguageVersion.Preview),path:f.RelativePath)).ToList();
      var refPath=typeof(object).Assembly.Location;
      var refs=new List<MetadataReference>{MetadataReference.CreateFromFile(refPath)};
      var compilation=CSharpCompilation.Create("OpenClawStaticAnalysis",trees,refs,
        new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));
      var output=new List<OutputFile>();
      for(var i=0;i<trees.Count;i++) {
        var model=compilation.GetSemanticModel(trees[i],ignoreAccessibility:true);
        output.Add(Parse(request.Files[i],trees[i],model));
      }
      await Console.Out.WriteAsync(JsonSerializer.Serialize(new OutputResponse(true,"roslyn-sdk",output),JsonOpts));
      return 0;
    } catch {
      await Console.Out.WriteAsync("{\"ok\":false,\"parser\":\"roslyn-sdk\",\"files\":[]}");
      return 2;
    }
  }
}
