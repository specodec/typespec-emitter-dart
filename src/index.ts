import {
  EmitContext,
  emitFile,
  Model,
  Type,
  Scalar,
} from "@typespec/compiler";
import {
  collectServices,
  ServiceInfo,
  BaseEmitterOptions,
  extractFields,
  scalarName,
  isArrayType,
  isRecordType,
  isModelType,
  arrayElementType,
  recordElementType,
  toSnakeCase,
  checkAndReportReservedKeywords,
} from "@specodec/typespec-emitter-core";

export type EmitterOptions = BaseEmitterOptions;

function dartScalarType(name: string): string {
  switch (name) {
    case "string": return "String";
    case "boolean": return "bool";
    case "int8": case "int16": case "int32": case "integer":
    case "uint8": case "uint16": case "uint32": return "int";
    case "int64": case "uint64": return "BigInt";
    case "float32": case "float64": case "float": case "decimal": return "double";
    case "bytes": return "Uint8List";
    default: return "dynamic";
  }
}

function dartBaseType(type: Type): string {
  if (isArrayType(type)) return `List<${dartBaseType(arrayElementType(type))}>`;
  if (isRecordType(type)) return `Map<String, ${dartBaseType(recordElementType(type))}>`;
  const n = scalarName(type);
  if (n) return dartScalarType(n);
  if (type.kind === "Enum") return "String";
  if (type.kind === "Model") return (type as Model).name || "dynamic";
  return "dynamic";
}

function dartTypeFor(type: Type, optional: boolean): string {
  return optional ? dartBaseType(type) + "?" : dartBaseType(type);
}

function defaultVal(type: Type): string {
  const n = scalarName(type);
  if (n === "string") return "''";
  if (n === "boolean") return "false";
  if (["int8","int16","int32","integer","uint8","uint16","uint32"].includes(n)) return "0";
  if (["int64","uint64"].includes(n)) return "BigInt.zero";
  if (["float32","float64","float","decimal"].includes(n)) return "0.0";
  if (n === "bytes") return "Uint8List(0)";
  if (isArrayType(type)) return "[]";
  if (type.kind === "Enum") return "''";
  return "null";
}

function writeExpr(expr: string, type: Type, w: string): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    return `${w}.beginArray(${expr}.length); for (final item in ${expr}) { ${w}.nextElement(); ${writeExpr("item", elem, w)}; } ${w}.endArray()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type);
    return `${w}.beginObject(${expr}.length); for (final entry in ${expr}.entries) { ${w}.writeField(entry.key); ${writeExpr("entry.value", elem, w)}; } ${w}.endObject()`;
  }
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string": return `${w}.writeString(${expr})`;
      case "boolean": return `${w}.writeBool(${expr})`;
      case "int8": case "int16": case "int32": case "integer": return `${w}.writeInt32(${expr})`;
      case "int64": return `${w}.writeInt64(${expr})`;
      case "uint8": case "uint16": case "uint32": return `${w}.writeUint32(${expr})`;
      case "uint64": return `${w}.writeUint64(${expr})`;
      case "float32": return `${w}.writeFloat32(${expr})`;
      case "float64": case "float": case "decimal": return `${w}.writeFloat64(${expr})`;
      case "bytes": return `${w}.writeBytes(${expr})`;
      default: return `${w}.writeString(${expr}.toString())`;
    }
  }
  if (type.kind === "Enum") return `${w}.writeEnum(${expr})`;
  if (isModelType(type)) return `write${(type as Model).name}(${w}, ${expr})`;
  return `// TODO: unknown type`;
}

function readExpr(type: Type, optional?: boolean): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    return `() { final list = <${dartBaseType(elem)}>[]; r.beginArray(); while (r.hasNextElement()) { list.add(${readExpr(elem)}); } r.endArray(); return list; }()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type);
    return `() { final map = <String, ${dartBaseType(elem)}>{}; r.beginObject(); while (r.hasNextField()) { final key = r.readFieldName(); map[key] = ${readExpr(elem)}; } r.endObject(); return map; }()`;
  }
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string": return "r.readString()";
      case "boolean": return "r.readBool()";
      case "int8": case "int16": case "int32": case "integer": return "r.readInt32()";
      case "int64": return "r.readInt64()";
      case "uint8": case "uint16": case "uint32": return "r.readUint32()";
      case "uint64": return "r.readUint64()";
      case "float32": return "r.readFloat32()";
      case "float64": case "float": case "decimal": return "r.readFloat64()";
      case "bytes": return "r.readBytes()";
      default: return "r.readString()";
    }
  }
  if (type.kind === "Enum") return "r.readEnum()";
  if (type.kind === "Model" && (type as Model).name) {
    if (optional) return `r.isNull() ? (() { r.readNull(); return null; })() : ${(type as Model).name}Codec.decode(r)`;
    return `${(type as Model).name}Codec.decode(r)`;
  }
  return "r.readString()";
}

function emitModel(model: Model): string {
  const name = model.name;
  const props = [...model.properties.values()];
  const requiredFields = props.filter(p => !p.optional);
  const optionalFields = props.filter(p => p.optional);
  const lines: string[] = [];

  lines.push(`class ${name} {`);
  for (const prop of props) {
    lines.push(`  final ${dartTypeFor(prop.type, prop.optional)} ${prop.name};`);
  }
  if (props.length > 0) {
    const ctorParams = props.map(p => p.optional ? `this.${p.name}` : `required this.${p.name}`).join(", ");
    lines.push(`  ${name}({${ctorParams}});`);
  } else {
    lines.push(`  ${name}();`);
  }
  lines.push(`}`);
  lines.push(``);

  lines.push(`void write${name}(SpecWriter w, ${name} obj) {`);
  if (optionalFields.length > 0) {
    lines.push(`  var fieldCount = ${requiredFields.length};`);
    for (const prop of optionalFields) lines.push(`  if (obj.${prop.name} != null) fieldCount++;`);
    lines.push(`  w.beginObject(fieldCount);`);
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

  lines.push(`final ${name}Codec = SpecCodec<${name}>(`);
  lines.push(`  encode: (w, obj) => write${name}(w, obj),`);
  lines.push(`  decode: (r) {`);
  for (const prop of props) {
    const dartType = dartBaseType(prop.type);
    if (prop.optional) {
      lines.push(`    ${dartType}? ${prop.name}Val;`);
    } else if (isModelType(prop.type)) {
      lines.push(`    late ${dartType} ${prop.name}Val;`);
    } else {
      lines.push(`    ${dartType} ${prop.name}Val = ${defaultVal(prop.type)};`);
    }
  }
  lines.push(`    r.beginObject();`);
  lines.push(`    while (r.hasNextField()) {`);
  lines.push(`      switch (r.readFieldName()) {`);
  for (const prop of props) {
    lines.push(`        case '${prop.name}': ${prop.name}Val = ${readExpr(prop.type, prop.optional)}; break;`);
  }
  lines.push(`        default: r.skip();`);
  lines.push(`      }`);
  lines.push(`    }`);
  lines.push(`    r.endObject();`);
  lines.push(`    return ${name}(${props.map(p => `${p.name}: ${p.name}Val`).join(", ")});`);
  lines.push(`  },`);
  lines.push(`);`);
  lines.push(``);

  return lines.join("\n");
}

export async function $onEmit(context: EmitContext<EmitterOptions>): Promise<void> {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const ignoreReservedKeywords = context.options["ignore-reserved-keywords"] ?? false;
  const services = collectServices(program);

  if (checkAndReportReservedKeywords(program, services, ignoreReservedKeywords)) return;

  for (const svc of services) {
    if (svc.models.length === 0) continue;
    const lines: string[] = [];
    lines.push(`import 'dart:typed_data';`);
    lines.push(`import 'package:specodec/specodec.dart';`);
    lines.push(``);
    for (const model of svc.models) {
      lines.push(emitModel(model));
    }
    const fileName = `${toSnakeCase(svc.serviceName)}_types.dart`;
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: lines.join("\n") });
  }
}
