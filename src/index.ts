import { type EmitContext, emitFile, type Model, type Type, type Enum } from "@typespec/compiler";
import {
  collectServices,
  type BaseEmitterOptions,
  type EnumInfo,
  type EnumMemberInfo,
  type UnionInfo,
  type UnionVariantInfo,
  scalarName,
  isArrayType,
  isRecordType,
  isModelType,
  isUnionType,
  isScalarVariant,
  arrayElementType,
  recordElementType,
  toCamelCase,
  dottedPathToSnakeCase,
  checkAndReportReservedKeywords,
  safeFieldName,
} from "@specodec/typespec-emitter-core";

export type EmitterOptions = BaseEmitterOptions;

function dartScalarType(name: string): string {
  switch (name) {
    case "string":
      return "String";
    case "boolean":
      return "bool";
    case "int8":
    case "int16":
    case "int32":
    case "integer":
    case "uint8":
    case "uint16":
    case "uint32":
      return "int";
    case "int64":
    case "uint64":
      return "BigInt";
    case "float32":
    case "float64":
    case "float":
    case "decimal":
      return "double";
    case "bytes":
      return "Uint8List";
    default:
      return "dynamic";
  }
}

function dartBaseType(type: Type): string {
  if (isArrayType(type)) return `List<${dartBaseType(arrayElementType(type)!)}>`;
  if (isRecordType(type)) return `Map<String, ${dartBaseType(recordElementType(type)!)}>`;
  const n = scalarName(type);
  if (n) return dartScalarType(n);
  if (type.kind === "Enum") return "String";
  if (isUnionType(type)) return (type as any).name;
  if (type.kind === "Model") return (type as Model).name || "dynamic";
  return "dynamic";
}

function dartTypeFor(type: Type, optional: boolean): string {
  return optional ? `${dartBaseType(type)}?` : dartBaseType(type);
}

function defaultVal(type: Type): string {
  const n = scalarName(type);
  if (n === "string") return "''";
  if (n === "boolean") return "false";
  if (["int8", "int16", "int32", "integer", "uint8", "uint16", "uint32"].includes(n)) return "0";
  if (["int64", "uint64"].includes(n)) return "BigInt.zero";
  if (["float32", "float64", "float", "decimal"].includes(n)) return "0.0";
  if (n === "bytes") return "Uint8List(0)";
  if (isArrayType(type)) return "[]";
  if (type.kind === "Enum") return "''";
  return "null";
}

function writeExpr(expr: string, type: Type, w: string): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type)!;
    return `${w}.beginArray(${expr}.length); for (final item in ${expr}) { ${w}.nextElement(); ${writeExpr("item", elem, w)}; } ${w}.endArray()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type)!;
    return `${w}.beginObject(${expr}.length); for (final entry in ${expr}.entries) { ${w}.writeField(entry.key); ${writeExpr("entry.value", elem, w)}; } ${w}.endObject()`;
  }
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string":
        return `${w}.writeString(${expr})`;
      case "boolean":
        return `${w}.writeBool(${expr})`;
      case "int8":
      case "int16":
      case "int32":
      case "integer":
        return `${w}.writeInt32(${expr})`;
      case "int64":
        return `${w}.writeInt64(${expr})`;
      case "uint8":
      case "uint16":
      case "uint32":
        return `${w}.writeUint32(${expr})`;
      case "uint64":
        return `${w}.writeUint64(${expr})`;
      case "float32":
        return `${w}.writeFloat32(${expr})`;
      case "float64":
      case "float":
      case "decimal":
        return `${w}.writeFloat64(${expr})`;
      case "bytes":
        return `${w}.writeBytes(${expr})`;
      default:
        return `${w}.writeString(${expr}.toString())`;
    }
  }
  if (type.kind === "Enum") return `${w}.writeString(${expr})`;
  if (isUnionType(type)) return `write${(type as any).name}(${w}, ${expr})`;
  if (isModelType(type)) return `${(type as Model).name}Codec.encode(w, ${expr})`;
  return `// TODO: unknown type`;
}

function readExpr(type: Type, optional?: boolean): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type)!;
    return `() { final list = <${dartBaseType(elem)}>[]; r.beginArray(); while (r.hasNextElement()) { list.add(${readExpr(elem)}); } r.endArray(); return list; }()`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type)!;
    return `() { final map = <String, ${dartBaseType(elem)}>{}; r.beginObject(); while (r.hasNextField()) { final key = r.readFieldName(); map[key] = ${readExpr(elem)}; } r.endObject(); return map; }()`;
  }
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string":
        return "r.readString()";
      case "boolean":
        return "r.readBool()";
      case "int8":
      case "int16":
      case "int32":
      case "integer":
        return "r.readInt32()";
      case "int64":
        return "r.readInt64()";
      case "uint8":
      case "uint16":
      case "uint32":
        return "r.readUint32()";
      case "uint64":
        return "r.readUint64()";
      case "float32":
        return "r.readFloat32()";
      case "float64":
      case "float":
      case "decimal":
        return "r.readFloat64()";
      case "bytes":
        return "r.readBytes()";
      default:
        return "r.readString()";
    }
  }
  if (type.kind === "Enum") return "r.readString()";
  if (isUnionType(type)) return `decode${(type as any).name}(r)`;
  if (type.kind === "Model" && (type as Model).name) {
    if (optional) return `r.isNull() ? (() { r.readNull(); return null; })() : ${(type as Model).name}Codec.decode(r)`;
    return `${(type as Model).name}Codec.decode(r)`;
  }
  return "r.readString()";
}

function generateEnumCode(e: EnumInfo): string {
  const lines: string[] = [];
  lines.push(`enum ${e.name} {`);
  const memberLines = e.members.map((m) => `  ${m.name}(${m.value})`);
  lines.push(memberLines.join(",\n"));
  lines.push(`;`);
  lines.push(`  final int value;`);
  lines.push(`  const ${e.name}(this.value);`);
  lines.push(`}`);
  return lines.join("\n");
}

function pascalCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function generateUnionCode(u: UnionInfo, L: string[]): void {
  const unionName = u.name;

  L.push(`sealed class ${unionName} {}`);
  L.push(``);

  L.push(`class ${unionName}Undefined extends ${unionName} {`);
  L.push(`  final SpecUndefined value;`);
  L.push(`  ${unionName}Undefined(this.value);`);
  L.push(`}`);
  L.push(``);

  for (const v of u.variants) {
    const className = `${unionName}${pascalCase(v.name)}`;
    const dartType = dartBaseType(v.type);
    L.push(`class ${className} extends ${unionName} {`);
    L.push(`  final ${dartType} value;`);
    L.push(`  ${className}(this.value);`);
    L.push(`}`);
    L.push(``);
  }

  L.push(`void write${unionName}(SpecWriter w, ${unionName} obj) {`);
  L.push(`  w.beginObject(1);`);
  L.push(`  switch (obj) {`);
  L.push(`    case ${unionName}Undefined(): throw Exception('cannot encode Undefined for ${unionName}');`);
  for (const v of u.variants) {
    const className = `${unionName}${pascalCase(v.name)}`;
    const we = writeExpr("value", v.type, "w");
    L.push(`    case ${className}(:final value): w.writeField("${v.name}"); ${we}; break;`);
  }
  L.push(`  }`);
  L.push(`  w.endObject();`);
  L.push(`}`);
  L.push(``);

  L.push(`${unionName} decode${unionName}(SpecReader r) {`);
  L.push(`  r.beginObject();`);
  L.push(`  if (!r.hasNextField()) { r.endObject(); throw Exception("empty union"); }`);
  L.push(`  final field = r.readFieldName();`);
  L.push(`  ${unionName} result;`);
  L.push(`  switch (field) {`);
  for (const v of u.variants) {
    const className = `${unionName}${pascalCase(v.name)}`;
    const re = readExpr(v.type);
    L.push(`    case "${v.name}": result = ${className}(${re}); break;`);
  }
  L.push(`    default: throw Exception("unknown variant \$field");`);
  L.push(`  }`);
  L.push(`  while (r.hasNextField()) { r.readFieldName(); r.skip(); }`);
  L.push(`  r.endObject();`);
  L.push(`  return result;`);
  L.push(`}`);
  L.push(``);

  L.push(`final ${unionName}Codec = SpecCodec<${unionName}>(encode: write${unionName}, decode: decode${unionName});`);
  L.push(``);
}

function emitModel(model: Model): string {
  const name = model.name;
  const props = [...model.properties.values()];
  const requiredFields = props.filter((p) => !p.optional);
  const optionalFields = props.filter((p) => p.optional);
  const dartField = (p: any) => safeFieldName("dart", toCamelCase(p.name));
  const lines: string[] = [];

  lines.push(`class ${name} {`);
  for (const prop of props) {
    lines.push(`  final ${dartTypeFor(prop.type, prop.optional)} ${dartField(prop)};`);
  }
  if (props.length > 0) {
    const ctorParams = props
      .map((p) => (p.optional ? `this.${dartField(p)}` : `required this.${dartField(p)}`))
      .join(", ");
    lines.push(`  ${name}({${ctorParams}});`);
  } else {
    lines.push(`  ${name}();`);
  }
  lines.push(`}`);
  lines.push(``);

  lines.push(`void write${name}(SpecWriter w, ${name} obj) {`);
  if (optionalFields.length > 0) {
    lines.push(`  var fieldCount = ${requiredFields.length};`);
    for (const prop of optionalFields) lines.push(`  if (obj.${dartField(prop)} != null) fieldCount++;`);
    lines.push(`  w.beginObject(fieldCount);`);
  } else {
    lines.push(`  w.beginObject(${props.length});`);
  }
  for (const prop of props) {
    if (prop.optional) {
      lines.push(
        `  if (obj.${dartField(prop)} != null) { w.writeField('${prop.name}'); ${writeExpr(`obj.${dartField(prop)}!`, prop.type, "w")}; }`,
      );
    } else {
      lines.push(`  w.writeField('${prop.name}'); ${writeExpr(`obj.${dartField(prop)}`, prop.type, "w")};`);
    }
  }
  lines.push(`  w.endObject();`);
  lines.push(`}`);
  lines.push(``);

  lines.push(`final SpecCodec<${name}> ${name}Codec = SpecCodec<${name}>(`);
  lines.push(`  encode: (w, obj) => write${name}(w, obj),`);
  lines.push(`  decode: (r) {`);
  for (const prop of props) {
    const dartType = dartBaseType(prop.type);
    const df = toCamelCase(prop.name);
    if (prop.optional) {
      lines.push(`    ${dartType}? ${df}Val;`);
    } else if (isModelType(prop.type)) {
      lines.push(`    late ${dartType} ${df}Val;`);
    } else if (isUnionType(prop.type)) {
      lines.push(`    ${dartType} ${df}Val = ${dartType}Undefined(SpecUndefined.instance);`);
    } else {
      lines.push(`    ${dartType} ${df}Val = ${defaultVal(prop.type)};`);
    }
  }
  lines.push(`    r.beginObject();`);
  lines.push(`    while (r.hasNextField()) {`);
  lines.push(`      switch (r.readFieldName()) {`);
  for (const prop of props) {
    const df = toCamelCase(prop.name);
    lines.push(`        case '${prop.name}': ${df}Val = ${readExpr(prop.type, prop.optional)}; break;`);
  }
  lines.push(`        default: r.skip();`);
  lines.push(`      }`);
  lines.push(`    }`);
  lines.push(`    r.endObject();`);
  lines.push(
    `    return ${name}(${props.map((p) => `${toCamelCase(p.name)}: ${toCamelCase(p.name)}Val`).join(", ")});`,
  );
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
    if (svc.models.length === 0 && svc.enums.length === 0 && svc.unions.length === 0) continue;
    const lines: string[] = [];
    lines.push(`import 'dart:typed_data';`);
    lines.push(`import 'package:specodec/specodec.dart' show SpecUndefined, SpecWriter, SpecReader, SpecCodec;`);
    lines.push(`import 'all_types.dart';`);
    lines.push(``);
    for (const e of svc.enums) lines.push(generateEnumCode(e));
    if (svc.enums.length > 0) lines.push(``);
    for (const model of svc.models) {
      lines.push(emitModel(model));
    }
    for (const u of svc.unions) {
      generateUnionCode(u, lines);
    }
    const fileName = `${dottedPathToSnakeCase(svc.serviceName)}_types.dart`;
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: lines.join("\n") });
  }

  let barrelContent = "// Generated by @specodec/typespec-emitter-dart. DO NOT EDIT.\n";
  for (const svc of services) {
    if (svc.models.length === 0 && svc.enums.length === 0 && svc.unions.length === 0) continue;
    barrelContent += `export '${dottedPathToSnakeCase(svc.serviceName)}_types.dart';\n`;
  }
  await emitFile(program, { path: `${outputDir}/all_types.dart`, content: barrelContent });
}
