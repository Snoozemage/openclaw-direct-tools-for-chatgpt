<?php
/**
 * Static PHP/Laravel AST extractor. Parses source from stdin; NEVER include/eval
 * analyzed source, invoke Laravel, or load the target repository autoloader.
 * Only this helper's pinned nikic/php-parser dependency is loaded.
 */
declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use PhpParser\Node;
use PhpParser\Node\Arg;
use PhpParser\Node\Expr;
use PhpParser\Node\Name;
use PhpParser\Node\Scalar;
use PhpParser\Node\Stmt;
use PhpParser\ParserFactory;

const MAX_INPUT = 2_600_000;
const MAX_FACTS = 3500;

function value(?Node $node): ?string {
    if ($node instanceof Scalar\String_) return $node->value;
    if ($node instanceof Scalar\Int_ || $node instanceof Scalar\Float_) return (string)$node->value;
    if ($node instanceof Name || $node instanceof Node\Identifier) return $node->toString();
    if ($node instanceof Expr\ClassConstFetch && strtolower($node->name->toString()) === 'class') {
        return $node->class instanceof Name ? $node->class->toString() : null;
    }
    return null;
}

function exprName(?Node $node): ?string {
    if ($node instanceof Name) return $node->toString();
    if ($node instanceof Expr\Variable && is_string($node->name)) return '$' . $node->name;
    if ($node instanceof Expr\PropertyFetch && $node->name instanceof Node\Identifier) {
        return (exprName($node->var) ?? '?') . '->' . $node->name->name;
    }
    if ($node instanceof Expr\StaticCall) return (exprName($node->class) ?? '?') . '::' . (value($node->name) ?? '?');
    if ($node instanceof Expr\MethodCall || $node instanceof Expr\NullsafeMethodCall) {
        return (exprName($node->var) ?? '?') . '->' . (value($node->name) ?? '?');
    }
    return null;
}

function args(Node $node): array {
    return $node instanceof Expr\CallLike ? $node->args : [];
}
function arg(Node $node, int $i): ?Node {
    $args = args($node);
    return isset($args[$i]) && $args[$i] instanceof Arg ? $args[$i]->value : null;
}
function leaf(?Node $node): ?string {
    return value($node) ?? exprName($node);
}
function strings(?Node $node): array {
    if (!$node instanceof Expr\Array_) return [];
    $list = [];
    foreach ($node->items as $item) {
        if (!$item) continue;
        $val = value($item->value);
        if ($val !== null) $list[] = $val;
    }
    return array_slice($list, 0, 120);
}
function namedArray(?Node $node): array {
    if (!$node instanceof Expr\Array_) return [];
    $map = [];
    foreach ($node->items as $item) {
        if (!$item) continue;
        $key = value($item->key);
        $val = value($item->value);
        if ($key !== null && $val !== null && count($map) < 120) $map[$key] = $val;
    }
    return $map;
}
function normalizedPath(string $path): string {
    if ($path === '') return '/';
    return '/' . trim(preg_replace('~/+~', '/', $path), '/');
}
function joinPath(string $parent, ?string $child): ?string {
    if ($child === null) return null;
    return normalizedPath(trim($parent, '/') . '/' . trim($child, '/'));
}
function fullName(string $name, string $namespace, array $imports): string {
    if (str_starts_with($name, '\\')) return ltrim($name, '\\');
    $parts = explode('\\', $name);
    $alias = strtolower($parts[0]);
    if (isset($imports[$alias])) {
        return $imports[$alias] . (count($parts) > 1 ? '\\' . implode('\\', array_slice($parts, 1)) : '');
    }
    return trim($namespace . '\\' . $name, '\\');
}
function classValue(?Node $node, string $namespace, array $imports): ?string {
    $raw = value($node);
    if ($raw === null) return null;
    return fullName($raw, $namespace, $imports);
}
function walk(Node $node, callable $callback): void {
    $callback($node);
    foreach ($node->getSubNodeNames() as $key) {
        $part = $node->$key;
        if ($part instanceof Node) walk($part, $callback);
        elseif (is_array($part)) foreach ($part as $child) if ($child instanceof Node) walk($child, $callback);
    }
}

function fact(array &$facts, string $kind, string $name, Node $node, array $details = [],
              ?string $parent = null, ?string $target = null, string $certainty = 'verified_static'): void {
    if (count($facts) >= MAX_FACTS) return;
    $facts[] = [
        'kind' => $kind, 'name' => mbCut($name), 'parent' => $parent === null ? null : mbCut($parent),
        'target' => $target === null ? null : mbCut($target),
        'startLine' => max(1, $node->getStartLine()), 'endLine' => max(1, $node->getEndLine()),
        'status' => $certainty, 'details' => $details,
    ];
}
function mbCut(string $s): string { return substr($s, 0, 600); }
function importMap(array $nodes): array {
    $map = [];
    foreach ($nodes as $node) {
        if ($node instanceof Stmt\Use_) {
            foreach ($node->uses as $use) {
                $full = $use->name->toString();
                $alias = strtolower($use->alias?->toString() ?? basename(str_replace('\\', '/', $full)));
                $map[$alias] = $full;
            }
        } elseif ($node instanceof Stmt\GroupUse) {
            foreach ($node->uses as $use) {
                $full = $node->prefix->toString() . '\\' . $use->name->toString();
                $alias = strtolower($use->alias?->toString() ?? basename(str_replace('\\', '/', $full)));
                $map[$alias] = $full;
            }
        }
    }
    return $map;
}

function isRouteClass(?Node $node, array $imports): bool {
    if (!$node instanceof Name) return false;
    $raw = $node->toString();
    if (strtolower($raw) === 'route' || strtolower($raw) === 'illuminate\\support\\facades\\route') return true;
    return strtolower($imports[strtolower($raw)] ?? '') === 'illuminate\\support\\facades\\route';
}
function routeRoot(Node $node, array $imports): bool {
    if ($node instanceof Expr\StaticCall) return isRouteClass($node->class, $imports);
    if ($node instanceof Expr\MethodCall) return routeRoot($node->var, $imports);
    return false;
}

function routeChain(Node $expr, array $imports): array {
    $calls = [];
    $current = $expr;
    while ($current instanceof Expr\MethodCall) {
        array_unshift($calls, [strtolower(value($current->name) ?? ''), $current]);
        $current = $current->var;
    }
    if ($current instanceof Expr\StaticCall && isRouteClass($current->class, $imports)) {
        array_unshift($calls, [strtolower(value($current->name) ?? ''), $current]);
    }
    return $calls;
}
function routeOptions(array $base, array $calls, string $namespace, array $imports): array {
    foreach ($calls as [$method, $call]) {
        if ($method === 'prefix') {
            $prefix = value(arg($call, 0));
            if ($prefix !== null) $base['prefix'] = normalizedPath(trim($base['prefix'], '/') . '/' . trim($prefix, '/'));
            else $base['dynamic'] = true;
        }
        if ($method === 'controller') {
            $resolved = classValue(arg($call, 0), $namespace, $imports);
            $base['controller'] = $resolved;
            if ($resolved === null) $base['dynamic'] = true;
        }
        if ($method === 'as' || $method === 'name') {
            $name = value(arg($call, 0));
            if ($name !== null) $base['name'] .= $name;
            else $base['dynamic'] = true;
        }
        if ($method === 'middleware') {
            $param = arg($call, 0);
            $list = value($param);
            $base['middleware'] = array_slice(array_merge($base['middleware'], $list === null ? strings($param) : [$list]), 0, 20);
        }
    }
    return $base;
}
function controllerAction(?Node $node, ?string $default, string $namespace, array $imports): ?string {
    if ($node instanceof Expr\Array_ && count($node->items) >= 2) {
        $controller = classValue($node->items[0]?->value, $namespace, $imports);
        $action = value($node->items[1]?->value);
        if ($controller !== null && $action !== null) return $controller . '@' . $action;
    }
    $text = value($node);
    if ($text === null) return null;
    if (str_contains($text, '@')) {
        [$class, $method] = explode('@', $text, 2);
        return fullName($class, $namespace, $imports) . '@' . $method;
    }
    if ($default !== null) return $default . '@' . $text;
    return null;
}

function routeStatements(array $stmts, array $scope, array &$facts, string $namespace, array $imports): void {
    $http = ['get'=>['GET'], 'post'=>['POST'], 'put'=>['PUT'], 'patch'=>['PATCH'], 'delete'=>['DELETE'],
             'options'=>['OPTIONS'], 'any'=>['GET','POST','PUT','PATCH','DELETE','OPTIONS'], 'match'=>[]];
    foreach ($stmts as $stmt) {
        if ($stmt instanceof Stmt\Namespace_) {
            routeStatements($stmt->stmts, $scope, $facts, $stmt->name?->toString() ?? '', importMap($stmt->stmts));
            continue;
        }
        if ($stmt instanceof Stmt\If_) {
            routeStatements($stmt->stmts, $scope, $facts, $namespace, $imports);
            foreach ($stmt->elseifs as $elif) routeStatements($elif->stmts, $scope, $facts, $namespace, $imports);
            if ($stmt->else) routeStatements($stmt->else->stmts, $scope, $facts, $namespace, $imports);
            continue;
        }
        if (!$stmt instanceof Stmt\Expression) continue;
        $expr = $stmt->expr;
        if (!routeRoot($expr, $imports)) continue;
        $chain = routeChain($expr, $imports);
        $last = $chain ? end($chain)[0] : null;

        if ($last === 'group') {
            $groupCall = end($chain)[1];
            $inner = routeOptions($scope, array_slice($chain, 0, -1), $namespace, $imports);
            $closure = arg($groupCall, 0);
            if ($closure instanceof Expr\Closure || $closure instanceof Expr\ArrowFunction) {
                if ($closure instanceof Expr\Closure) routeStatements($closure->stmts, $inner, $facts, $namespace, $imports);
            }
            continue;
        }

        if ($last === 'name' || $last === 'middleware' || $last === 'where') {
            $routeAt = null;
            foreach ($chain as $i => $pair) if (isset($http[$pair[0]]) || in_array($pair[0], ['resource','apiresource'], true)) $routeAt = $i;
            if ($routeAt === null) continue;
        }
        $index = null;
        foreach ($chain as $i => $pair) {
            if (isset($http[$pair[0]]) || in_array($pair[0], ['resource', 'apiresource'], true)) {
                $index = $i; break;
            }
        }
        if ($index === null) continue;
        [$verb, $call] = $chain[$index];
        $ctx = routeOptions($scope, array_slice($chain, 0, $index), $namespace, $imports);
        $suffix = routeOptions(['prefix'=>'/', 'name'=>'', 'middleware'=>[], 'controller'=>null,'dynamic'=>false],
                               array_slice($chain, $index + 1), $namespace, $imports);
        $uri = value(arg($call, 0));
        $routePath = joinPath($ctx['prefix'], $uri);
        $controller = controllerAction(arg($call, 1), $ctx['controller'], $namespace, $imports);
        $routeName = $ctx['name'] . $suffix['name'];
        $status = $ctx['dynamic'] || $suffix['dynamic'] || $uri === null ? 'unresolved' : 'verified_static';

        if ($verb === 'resource' || $verb === 'apiresource') {
            $class = classValue(arg($call, 1), $namespace, $imports);
            $basePath = $routePath ?? '';
            $parameter = $uri === null ? '{resource}' : '{' . rtrim(str_replace(['-', '.'], '_', basename($uri)), 's') . '}';
            $rows = [['GET','/','index'], ['POST','/','store'],['GET','/'.$parameter,'show'],
                     ['PUT','/'.$parameter,'update'],['PATCH','/'.$parameter,'update'],['DELETE','/'.$parameter,'destroy']];
            if ($verb === 'resource') {
                array_splice($rows, 1, 0, [['GET','/create','create']]);
                array_splice($rows, 4, 0, [['GET','/'.$parameter.'/edit','edit']]);
            }
            foreach ($rows as [$verbName, $segment, $method]) {
                fact($facts,'route',$verbName.' '.normalizedPath($basePath . $segment),$call,[
                    'httpMethod'=>$verbName,'uri'=>normalizedPath($basePath . $segment),
                    'routeName'=>$routeName,'middleware'=>$ctx['middleware'],
                    'resourceConvention'=>true,'handler'=>$class === null ? null : $class.'@'.$method,
                ],null,$class === null ? null : $class.'@'.$method,'inferred');
            }
            continue;
        }

        $verbs = $http[$verb];
        if ($verb === 'match') $verbs = strings(arg($call, 0));
        if ($verb === 'match') {
            $routePath = joinPath($ctx['prefix'], value(arg($call, 1)));
            $controller = controllerAction(arg($call, 2), $ctx['controller'], $namespace, $imports);
        }
        if (!$verbs) $verbs = ['UNKNOWN'];
        foreach ($verbs as $method) {
            $method = strtoupper($method);
            fact($facts,'route',$method.' '.($routePath ?? '?'),$call,[
                'httpMethod'=>$method,'uri'=>$routePath,
                'routeName'=>$routeName,'middleware'=>$ctx['middleware'],
                'handler'=>$controller,
            ],null,$controller,$status);
        }
    }
}

function directDbTable(?Node $expr): ?string {
    while ($expr instanceof Expr\MethodCall || $expr instanceof Expr\NullsafeMethodCall) {
        $expr = $expr->var;
    }
    if ($expr instanceof Expr\StaticCall && $expr->class instanceof Name &&
        strtolower($expr->class->getLast()) === 'db' &&
        strtolower(value($expr->name) ?? '') === 'table') {
        return value(arg($expr,0));
    }
    return null;
}

function extractStructure(array $stmts, array &$facts, string $namespace='', array $imports=[]): void {
    $imports = importMap($stmts) + $imports;
    foreach ($stmts as $stmt) {
        if ($stmt instanceof Stmt\Namespace_) {
            extractStructure($stmt->stmts, $facts, $stmt->name?->toString() ?? '', []);
            continue;
        }
        if (!$stmt instanceof Stmt\Class_ && !$stmt instanceof Stmt\Interface_ && !$stmt instanceof Stmt\Trait_) continue;
        if (!$stmt->name) continue;
        $fqcn = trim($namespace.'\\'.$stmt->name->toString(),'\\');
        $kind = $stmt instanceof Stmt\Class_ ? 'class' : ($stmt instanceof Stmt\Interface_ ? 'interface' : 'trait');
        fact($facts,$kind,$fqcn,$stmt,['shortName'=>$stmt->name->toString()]);
        $table = null;
        $tableNode = null;
        $fieldNodes = [];
        $attrs = [];
        foreach ($stmt->stmts as $member) {
            if ($member instanceof Stmt\Property) {
                foreach ($member->props as $prop) {
                    $name = $prop->name->name;
                    if ($name === 'table') {
                        $table = value($prop->default);
                        $tableNode = $prop;
                    }
                    if (in_array($name,['fillable','casts','appends','guarded'],true)) {
                        $attrs[$name] = $name==='casts' ? namedArray($prop->default) : strings($prop->default);
                        if ($name === 'fillable' && $prop->default instanceof Expr\Array_) {
                            foreach ($prop->default->items as $item) {
                                $fieldName = $item === null ? null : value($item->value);
                                if ($fieldName !== null) $fieldNodes[$fieldName] = $item->value;
                            }
                        }
                    }
                }
            }
        }
        $isModel = $stmt instanceof Stmt\Class_ &&
            ($stmt->extends instanceof Name && (strtolower($stmt->extends->getLast()) === 'model' ||
             str_ends_with(strtolower($stmt->extends->toString()),'\\model')) || str_starts_with($namespace,'App\\Models'));
        if ($isModel) {
            fact($facts,'model',$fqcn,$stmt,['table'=>$table,'attributes'=>$attrs],
                 $fqcn,$table,'verified_static');
            if ($table !== null) fact($facts,'model_table',$fqcn.' -> '.$table,$tableNode ?? $stmt,
                ['table'=>$table],$fqcn,$table);
            foreach (($attrs['fillable'] ?? []) as $field) {
                fact($facts,'model_field',$field,$fieldNodes[$field] ?? $stmt,['model'=>$fqcn,'source'=>'fillable'],
                     $fqcn);
            }
        }
        foreach ($stmt->stmts as $member) {
            if (!$member instanceof Stmt\ClassMethod) continue;
            $method = $member->name->name;
            $methodId = $fqcn.'@'.$method;
            fact($facts,'method',$methodId,$member,[
                'visibility'=>$member->isPublic() ? 'public' : ($member->isProtected() ? 'protected' : 'private'),
            ],$fqcn);
            if (!$member->stmts) continue;
            $reported = [];
            foreach ($member->stmts as $bodyNode) walk($bodyNode, function(Node $node) use (&$reported,&$facts,$methodId,$namespace,$imports,$isModel) {
                if ($node instanceof Expr\FuncCall && $node->name instanceof Name &&
                    strtolower($node->name->toString()) === 'view') {
                    $viewName = value(arg($node,0));
                    if ($viewName !== null && preg_match('/^[A-Za-z0-9._-]+$/', $viewName)) {
                        $viewPath = 'resources/views/' . str_replace('.', '/', $viewName) . '.blade.php';
                        fact($facts,'view_render',$methodId.' -> '.$viewName,$node,[
                            'viewName'=>$viewName,'viewPathCandidate'=>$viewPath
                        ],$methodId,$viewPath,'inferred');
                    }
                }
                if ($node instanceof Expr\MethodCall) {
                    $call = strtolower(value($node->name) ?? '');
                    if (in_array($call,['get','first','count','exists','insert','update',
                        'delete','upsert','increment','decrement'],true)) {
                        $directTable = directDbTable($node);
                        if ($directTable !== null) {
                            $key='dbop:'.$node->getStartLine().':'.$call.':'.$directTable;
                            if (!isset($reported[$key])) {
                                $reported[$key] = true;
                                fact($facts,'table_operation',$methodId.' '.$call.' '.$directTable,$node,[
                                    'table'=>$directTable,'operation'=>$call,'evidence'=>'direct_db_builder_chain',
                                ],$methodId,$directTable,'verified_static');
                            }
                        }
                    }
                    if (in_array($call,['belongsto','hasmany','hasone','belongstomany','morphto','morphmany','morphone'],true)) {
                        $target = classValue(arg($node,0),$namespace,$imports);
                        $relation = $node;
                        $key = 'relation:'.$relation->getStartLine().':'.$call;
                        if (!isset($reported[$key])) {
                            $reported[$key] = true;
                            fact($facts,'eloquent_relation',$methodId.' -> '.($target ?? '?'),$node,[
                                'relation'=>$call,'foreignKey'=>value(arg($node,1)),
                                'targetClass'=>$target,
                            ],$methodId,$target,$target === null ? 'unresolved' : 'verified_static');
                        }
                    }
                    // Bounded query-builder operation inference. This does not prove runtime execution.
                    if (in_array($call,['insert','update','delete','get','first','count','exists','paginate','pluck','sum','max','min'],true)) {
                        $rootCall = $node->var;
                        while ($rootCall instanceof Expr\MethodCall) $rootCall = $rootCall->var;
                        if ($rootCall instanceof Expr\StaticCall && $rootCall->class instanceof Name &&
                            strtolower($rootCall->class->getLast()) === 'db' &&
                            strtolower(value($rootCall->name) ?? '') === 'table') {
                            $dbTable = value(arg($rootCall,0));
                            if ($dbTable !== null) {
                                $key='query-operation:'.$node->getStartLine().':'.$call.':'.$dbTable;
                                if (!isset($reported[$key])) {
                                    $reported[$key]=true;
                                    fact($facts,'table_access',$methodId.' '.$call.' '.$dbTable,$node,[
                                        'table'=>$dbTable,'operation'=>$call,
                                        'dataAction'=>in_array($call,['insert','update','delete'],true)?'write':'read',
                                        'evidence'=>'query_builder_chain',
                                    ],$methodId,$dbTable,'inferred');
                                }
                            }
                        }
                    }
                    if ($call === 'join' || $call === 'leftjoin' || $call === 'rightjoin') {
                        $table = value(arg($node,0));
                        if ($table !== null) {
                            $key='join:'.$node->getStartLine().':'.$table;
                            if (!isset($reported[$key])) {
                                $reported[$key]=true;
                                fact($facts,'table_access',$methodId.' join '.$table,$node,
                                    ['operation'=>'join','table'=>$table,'evidence'=>'query_builder'], $methodId,$table,'inferred');
                            }
                        }
                    }
                }
                if (!$node instanceof Expr\StaticCall) return;
                $call = strtolower(value($node->name) ?? '');
                if (!$node->class instanceof Name) return;
                $class = $node->class->toString();
                $base = strtolower($node->class->getLast());
                $table = value(arg($node,0));
                if (in_array($base,['db','schema'],true) && in_array($call,['table','create','drop','dropifexists','renametable'],true) && $table !== null) {
                    $key='table:'.$node->getStartLine().':'.$table;
                    if (isset($reported[$key])) return;
                    $reported[$key]=true;
                    fact($facts,$base==='schema'?'migration_table':'table_access',$methodId.' -> '.$table,$node,[
                        'table'=>$table,'operation'=>$call,'evidence'=>$base,
                    ],$methodId,$table, $call==='table' ? 'inferred':'verified_static');
                    return;
                }
                $target = fullName($class,$namespace,$imports);
                if (in_array($base,['route','schema','db','static','self','parent'],true)) return;
                $key='call:'.$node->getStartLine().':'.$target.'@'.$call;
                if (isset($reported[$key])) return;
                $reported[$key]=true;
                fact($facts,'static_call',$methodId.' => '.$target.'@'.$call,$node,[
                    'invokedMethod'=>$call,'class'=>$target,
                ],$methodId,$target.'@'.(value($node->name) ?? ''),'inferred');
            });
        }
    }
}

function migrations(array $stmts, array &$facts): void {
    foreach ($stmts as $stmt) walk($stmt,function(Node $node) use (&$facts) {
        if (!$node instanceof Expr\StaticCall || !$node->class instanceof Name ||
            strtolower($node->class->getLast())!=='schema') return;
        $method = strtolower(value($node->name) ?? '');
        if (!in_array($method,['create','table','drop','dropifexists','rename'],true)) return;
        $table = value(arg($node,0));
        if ($table === null) return;
        $columns=[];
        $columnNodes=[];
        $closure = arg($node,1);
        if ($closure instanceof Expr\Closure) {
            foreach ($closure->stmts as $sub) walk($sub,function(Node $item) use (&$columns,&$columnNodes) {
                if (!$item instanceof Expr\MethodCall) return;
                $kind = strtolower(value($item->name) ?? '');
                if (in_array($kind,['id','string','char','integer','biginteger','unsignedbiginteger','foreignid',
                    'boolean','decimal','float','double','text','longtext','date','datetime','timestamp','timestamps',
                    'json','jsonb','uuid','enum','softdeletes','foreign'],true)) {
                    $column = value(arg($item,0));
                    if ($column !== null && count($columns) < 120) {
                        $columns[] = $column;
                        $columnNodes[$column] = $item;
                    }
                }
            });
        }
        fact($facts,'migration_table',$method.' '.$table,$node,[
            'operation'=>$method,'table'=>$table,'columns'=>array_values(array_unique($columns)),
        ],null,$table);
        foreach (array_unique($columns) as $column) fact($facts,'migration_column',$table.'.'.$column,$columnNodes[$column] ?? $node,
            ['table'=>$table,'column'=>$column],$table);
    });
}

try {
    $raw=file_get_contents('php://stdin',false,null,0,MAX_INPUT+1);
    if ($raw===false || strlen($raw)>MAX_INPUT) throw new RuntimeException('Input exceeds parser size budget.');
    $request=json_decode($raw,true,64,JSON_THROW_ON_ERROR);
    if (!is_array($request) || ($request['version'] ?? null)!==1 ||
        !is_string($request['code'] ?? null) || !is_string($request['relativePath'] ?? null)) {
        throw new RuntimeException('Invalid static analysis input.');
    }
    $code = $request['code'];
    $relativePath = str_replace('\\','/',$request['relativePath']);
    if (strlen($relativePath)>1024 || str_contains($relativePath,'..') ||
        str_contains($relativePath,"\0")) throw new RuntimeException('Invalid source path.');
    $parser=(new ParserFactory())->createForNewestSupportedVersion();
    $stmts=$parser->parse($code) ?? [];
    $facts=[];
    extractStructure($stmts,$facts);
    if (preg_match('~(^|/)routes/[^/]+\.php$~i',$relativePath)) {
        routeStatements($stmts,['prefix'=>'/','name'=>'','middleware'=>[],
            'controller'=>null,'dynamic'=>false],$facts,'',importMap($stmts));
    }
    if (preg_match('~(^|/)database/migrations/[^/]+\.php$~i',$relativePath)) migrations($stmts,$facts);
    echo json_encode(['ok'=>true,'version'=>1,'parser'=>'nikic/php-parser','facts'=>$facts],
        JSON_THROW_ON_ERROR|JSON_INVALID_UTF8_SUBSTITUTE|JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES);
} catch (Throwable $error) {
    $kind=$error instanceof \PhpParser\Error ? 'PHP_PARSE_ERROR' : 'PHP_EXTRACT_ERROR';
    echo json_encode(['ok'=>false,'code'=>$kind,'message'=>'PHP AST could not be parsed for this file.'],
       JSON_THROW_ON_ERROR);
}
