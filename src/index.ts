import {
  EmitContext,
  Model,
  ModelProperty,
  Namespace,
  Program,
  Scalar,
  Type,
  Interface,
  Diagnostic,
  emitFile,
  listServices,
  getNamespaceFullName,
  navigateTypesInNamespace,
  resolvePath,
} from "@typespec/compiler";
import {
  checkReservedKeyword,
  formatReservedError,
} from "@specodec/typespec-specodec-core";

interface EmitterOptions {
  "output-dir"?: string;
  "ignore-reserved-keywords"?: boolean;
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([A-Z])/g, (m) => "_" + m.toLowerCase())
    .replace(/^_/, "");
}

function dartScalarType(name: string): string {
  switch (name) {
    case "string": return "String";
    case "boolean": return "bool";
    case "int8": case "int16": case "int32": case "integer":
    case "uint8": case "uint16": case "uint32":
      return "int";
    case "int64": case "uint64":
      return "BigInt";
    case "float32": case "float64": case "float": case "decimal":
      return "double";
    case "bytes": return "Uint8List";
    default: return "dynamic";
  }
}

function dartTypeFor(type: Type, optional: boolean): string {
  const base = dartBaseType(type);
  return optional ? base + "?" : base;
}

function dartBaseType(type: Type): string {
  if (type.kind === "Model") {
    const m = type as Model;
    if (m.indexer) {
      const keyName = (m.indexer.key as any).name;
      if (keyName === "integer") {
        const valueType = dartBaseType(m.indexer.value);
        return "List<" + valueType + ">";
      } else if (keyName === "string") {
        const valueType = dartBaseType(m.indexer.value);
        return "Map<String, " + valueType + ">";
      }
    }
    return m.name;
  }
  if (type.kind === "Enum") return "String";
  if (type.kind === "Scalar") return dartScalarType((type as Scalar).name);
  return "dynamic";
}

function isArrayType(type: Type): boolean {
  if (type.kind !== "Model" || !(type as Model).indexer) return false;
  const keyName = ((type as Model).indexer!.key as any).name;
  return keyName === "integer";
}

function isRecordType(type: Type): boolean {
  if (type.kind !== "Model" || !(type as Model).indexer) return false;
  const keyName = ((type as Model).indexer!.key as any).name;
  return keyName === "string";
}

function getArrayElementType(type: Type): Type {
  return (type as Model).indexer!.value;
}

function getRecordElementType(type: Type): Type {
  return (type as Model).indexer!.value;
}

function isModelType(type: Type): boolean {
  return type.kind === "Model" && !!(type as Model).name && !isArrayType(type);
}

// Single format-agnostic write expression using SpecWriter
function writeExpr(expr: string, type: Type, w: string): string {
  if (isArrayType(type)) {
    const elem = getArrayElementType(type);
    return `${w}.beginArray(${expr}.length); for (final _e in ${expr}) { ${w}.nextElement(); ${writeExpr("_e", elem, w)}; } ${w}.endArray()`;
  }
  if (isRecordType(type)) {
    const elem = getRecordElementType(type);
    return `${w}.beginObject(${expr}.length); for (final _e in ${expr}.entries) { ${w}.writeField(_e.key); ${writeExpr("_e.value", elem, w)}; } ${w}.endObject()`;
  }
  if (type.kind === "Scalar") {
    const s = type as Scalar;
    switch (s.name) {
      case "string": return `${w}.writeString(${expr})`;
      case "boolean": return `${w}.writeBool(${expr})`;
      case "int8": case "int16": case "int32": case "integer":
        return `${w}.writeInt32(${expr})`;
      case "int64": return `${w}.writeInt64(${expr})`;
      case "uint8": case "uint16": case "uint32":
        return `${w}.writeUint32(${expr})`;
      case "uint64": return `${w}.writeUint64(${expr})`;
      case "float32": return `${w}.writeFloat32(${expr})`;
      case "float64": case "float": case "decimal":
        return `${w}.writeFloat64(${expr})`;
      case "bytes": return `${w}.writeBytes(${expr})`;
      default: return `${w}.writeString(${expr}.toString())`;
    }
  }
  if (type.kind === "Enum") return `${w}.writeEnum(${expr})`;
  if (isModelType(type)) {
    return `_write${(type as Model).name}(${w}, ${expr})`;
  }
  return `// TODO: unknown type`;
}

function readExpr(type: Type, optional?: boolean): string {
  if (type.kind === "Scalar") {
    const s = type as Scalar;
    switch (s.name) {
      case "string": return "r.readString()";
      case "boolean": return "r.readBool()";
      case "int8": case "int16": case "int32": case "integer":
        return "r.readInt32()";
      case "int64": return "r.readInt64()";
      case "uint8": case "uint16": case "uint32":
        return "r.readUint32()";
      case "uint64": return "r.readUint64()";
      case "float32": return "r.readFloat32()";
      case "float64": case "float": case "decimal":
        return "r.readFloat64()";
      case "bytes": return "r.readBytes()";
      default: return "r.readString()";
    }
  }
  if (type.kind === "Enum") return "r.readEnum()";
  if (type.kind === "Model") {
    const m = type as Model;
    if (m.indexer) {
      const keyName = (m.indexer.key as any).name;
      if (keyName === "integer") {
        const elemType = getArrayElementType(type);
        const elemDartType = dartBaseType(elemType);
        const elemRead = readExpr(elemType);
        return `() { final _list = <${elemDartType}>[]; r.beginArray(); while (r.hasNextElement()) { _list.add(${elemRead}); } r.endArray(); return _list; }()`;
      } else if (keyName === "string") {
        const elemType = getRecordElementType(type);
        const elemDartType = dartBaseType(elemType);
        const elemRead = readExpr(elemType);
        return `() { final _map = <String, ${elemDartType}>{}; r.beginObject(); while (r.hasNextField()) { final _k = r.readFieldName(); _map[_k] = ${elemRead}; } r.endObject(); return _map; }()`;
      }
    }
    if (m.name) {
      if (optional) return `r.isNull() ? (() { r.readNull(); return null; })() : ${m.name}Codec.decode(r)`;
      return `${m.name}Codec.decode(r)`;
    }
  }
  return "r.readString()";
}

function defaultVal(type: Type): string {
  if (type.kind === "Scalar") {
    const s = type as Scalar;
    switch (s.name) {
      case "string": return "''";
      case "boolean": return "false";
      case "int8": case "int16": case "int32": case "integer":
      case "uint8": case "uint16": case "uint32":
        return "0";
      case "int64": case "uint64":
        return "BigInt.zero";
      case "float32": case "float64": case "float": case "decimal":
        return "0.0";
      case "bytes": return "Uint8List(0)";
      default: return "''";
    }
  }
  if (isArrayType(type)) return "[]";
  if (type.kind === "Enum") return "''";
  return "null";
}

function needsLate(type: Type, optional: boolean): boolean {
  return !optional && isModelType(type);
}

function emitModel(model: Model): string {
  const name = model.name;
  const props = [...model.properties.values()];
  const requiredFields = props.filter((p) => !p.optional);
  const optionalFields = props.filter((p) => p.optional);

  const lines: string[] = [];

  lines.push(`class ${name} {`);
  for (const prop of props) {
    const dartType = dartTypeFor(prop.type, prop.optional);
    lines.push(`  final ${dartType} ${prop.name};`);
  }
  if (props.length > 0) {
    const ctorParams = props
      .map((p) => {
        if (p.optional) return `this.${p.name}`;
        return `required this.${p.name}`;
      })
      .join(", ");
    lines.push(`  ${name}({${ctorParams}});`);
  } else {
    lines.push(`  ${name}();`);
  }
  lines.push(`}`);

  lines.push(``);
  lines.push(`void _write${name}(SpecWriter w, ${name} obj) {`);
  if (optionalFields.length > 0) {
    lines.push(`  var _n = ${requiredFields.length};`);
    for (const prop of optionalFields) {
      lines.push(`  if (obj.${prop.name} != null) _n++;`);
    }
    lines.push(`  w.beginObject(_n);`);
  } else {
    lines.push(`  w.beginObject(${props.length});`);
  }
  for (const prop of props) {
    if (prop.optional) {
      lines.push(`  if (obj.${prop.name} != null) { w.writeField('${prop.name}'); ${writeExpr(`obj.${prop.name}!`, prop.type, "w")}; }`);
    } else {
      lines.push(`  w.writeField('${prop.name}'); ${writeExpr(`obj.${prop.name}`, prop.type, "w")};`);
    }
  }
  lines.push(`  w.endObject();`);
  lines.push(`}`);

  lines.push(``);
  lines.push(`final SpecCodec<${name}> ${name}Codec = SpecCodec<${name}>(`);

  lines.push(`  encode: (w, obj) => _write${name}(w, obj),`);

  lines.push(`  decode: (r) {`);
  for (const prop of props) {
    const dartType = dartBaseType(prop.type);
    if (prop.optional) {
      lines.push(`    ${dartType}? _${prop.name};`);
    } else if (needsLate(prop.type, prop.optional)) {
      lines.push(`    late ${dartType} _${prop.name};`);
    } else {
      lines.push(`    ${dartType} _${prop.name} = ${defaultVal(prop.type)};`);
    }
  }
  lines.push(`    r.beginObject();`);
  lines.push(`    while (r.hasNextField()) {`);
  lines.push(`      switch (r.readFieldName()) {`);
  for (const prop of props) {
    lines.push(`        case '${prop.name}': _${prop.name} = ${readExpr(prop.type, prop.optional)}; break;`);
  }
  lines.push(`        default: r.skip();`);
  lines.push(`      }`);
  lines.push(`    }`);
  lines.push(`    r.endObject();`);
  const ctorArgs = props.map((p) => `${p.name}: _${p.name}`).join(", ");
  lines.push(`    return ${name}(${ctorArgs});`);
  lines.push(`  },`);
  lines.push(`);`);
  lines.push(``);

  return lines.join("\n");
}

function isStdLibNamespace(ns: Namespace): boolean {
  const fullName = getNamespaceFullName(ns);
  return fullName === "TypeSpec" || fullName.startsWith("TypeSpec.");
}

function collectServices(program: Program): { serviceName: string; models: Model[] }[] {
  const services = listServices(program);
  const result: { serviceName: string; models: Model[] }[] = [];

  function collectFromNs(ns: Namespace, iface?: Interface) {
    if (isStdLibNamespace(ns)) return;
    const models: Model[] = [];
    const seen = new Set<string>();
    navigateTypesInNamespace(ns, {
      model: (m: Model) => {
        if (m.name && !seen.has(m.name)) {
          const modelNs = m.namespace;
          if (modelNs && !isStdLibNamespace(modelNs)) {
            models.push(m);
            seen.add(m.name);
          }
        }
      },
    });
    if (models.length > 0) {
      result.push({ serviceName: iface?.name || ns.name || "TestService", models });
    }
  }

  for (const svc of services) collectFromNs(svc.type);
  if (result.length === 0) {
    const globalNs = program.getGlobalNamespaceType();
    for (const [, ns] of globalNs.namespaces) collectFromNs(ns);
    collectFromNs(globalNs);
  }
  return result;
}

export async function $onEmit(context: EmitContext<EmitterOptions>): Promise<void> {
  const outputDir = context.options["output-dir"] ?? context.emitterOutputDir;
  const program = context.program;
  const ignoreReservedKeywords = context.options["ignore-reserved-keywords"] ?? false;
  const services = collectServices(program);

  const reservedFieldErrors: Diagnostic[] = [];
  for (const svc of services) {
    for (const m of svc.models) {
      if (!m.name) continue;
      for (const [fieldName, prop] of m.properties) {
        const reservedIn = checkReservedKeyword(fieldName);
        if (reservedIn.length > 0) {
          const message = formatReservedError(fieldName, m.name, reservedIn);
          const diag: Diagnostic = {
            severity: "error",
            code: "reserved-keyword",
            message,
            target: prop,
          };
          reservedFieldErrors.push(diag);
        }
      }
    }
  }

  if (reservedFieldErrors.length > 0 && !ignoreReservedKeywords) {
    program.reportDiagnostics(reservedFieldErrors);
    return;
  }

  if (reservedFieldErrors.length > 0 && ignoreReservedKeywords) {
    for (const diag of reservedFieldErrors) {
      console.warn(`Warning: ${diag.message}`);
    }
  }

  for (const svc of services) {
    if (svc.models.length === 0) continue;
    const fileName = toSnakeCase(svc.serviceName) + "_types.dart";
    const lines: string[] = [];
    lines.push(`import 'dart:typed_data';`);
    lines.push(`import 'package:specodec/specodec.dart';`);
    lines.push(``);
    for (const model of svc.models) {
      lines.push(emitModel(model));
    }
    await emitFile(program, {
      path: resolvePath(outputDir, fileName),
      content: lines.join("\n"),
    });
  }
}
