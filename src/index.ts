import {
  EmitContext,
  Model,
  ModelProperty,
  Namespace,
  Program,
  Scalar,
  Type,
  emitFile,
  listServices,
  navigateTypesInNamespace,
  resolvePath,
} from "@typespec/compiler";

interface EmitterOptions {
  "output-dir"?: string;
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([A-Z])/g, (m) => "_" + m.toLowerCase())
    .replace(/^_/, "");
}

function dartTypeFor(type: Type, optional: boolean): string {
  const base = dartBaseType(type);
  return optional ? base + "?" : base;
}

function dartBaseType(type: Type): string {
  if (type.kind === "Scalar") {
    const s = type as Scalar;
    switch (s.name) {
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
  if (type.kind === "Model") {
    const m = type as Model;
    if (m.indexer) {
      const valueType = dartBaseType(m.indexer.value);
      return "List<" + valueType + ">";
    }
    return m.name;
  }
  if (type.kind === "Enum") return "String";
  return "dynamic";
}

function isArrayType(type: Type): boolean {
  if (type.kind === "Model") {
    const m = type as Model;
    return !!m.indexer;
  }
  return false;
}

function getArrayElementType(type: Type): Type {
  const m = type as Model;
  return m.indexer!.value;
}

function isModelType(type: Type): boolean {
  return type.kind === "Model" && !!(type as Model).name && !isArrayType(type);
}

function writeJsonExpr(expr: string, type: Type, w: string): string {
  if (isArrayType(type)) {
    const elem = getArrayElementType(type);
    return `${w}.beginArray(); for (final _e in ${expr}) { ${w}.nextElement(); ${writeJsonExpr("_e", elem, w)}; } ${w}.endArray()`;
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
    return `_writeJson${(type as Model).name}(${w}, ${expr})`;
  }
  return `// TODO: unknown type`;
}

function writeMsgPackExpr(expr: string, type: Type, w: string): string {
  if (isArrayType(type)) {
    const elem = getArrayElementType(type);
    return `${w}.beginArray(${expr}.length); for (final _e in ${expr}) { ${writeMsgPackExpr("_e", elem, w)}; } ${w}.endArray()`;
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
    return `_writeMsgPack${(type as Model).name}(${w}, ${expr})`;
  }
  return `// TODO: unknown type`;
}

function readExpr(type: Type): string {
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
      const elemType = getArrayElementType(type);
      const elemDartType = dartBaseType(elemType);
      const elemRead = readExpr(elemType);
      return `() { final _list = <${elemDartType}>[]; r.beginArray(); while (r.hasNextElement()) { _list.add(${elemRead}); } r.endArray(); return _list; }()`;
    }
    if (m.name) return `${m.name}Codec.decode(r)`;
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
  lines.push(`void _writeJson${name}(JsonWriter w, ${name} obj) {`);
  lines.push(`  w.beginObject();`);
  for (const prop of props) {
    if (prop.optional) {
      lines.push(`  if (obj.${prop.name} != null) { w.writeField('${prop.name}'); ${writeJsonExpr(`obj.${prop.name}!`, prop.type, "w")}; }`);
    } else {
      lines.push(`  w.writeField('${prop.name}'); ${writeJsonExpr(`obj.${prop.name}`, prop.type, "w")};`);
    }
  }
  lines.push(`  w.endObject();`);
  lines.push(`}`);

  lines.push(``);
  lines.push(`void _writeMsgPack${name}(MsgPackWriter w, ${name} obj) {`);
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
      lines.push(`  if (obj.${prop.name} != null) { w.writeField('${prop.name}'); ${writeMsgPackExpr(`obj.${prop.name}!`, prop.type, "w")}; }`);
    } else {
      lines.push(`  w.writeField('${prop.name}'); ${writeMsgPackExpr(`obj.${prop.name}`, prop.type, "w")};`);
    }
  }
  lines.push(`  w.endObject();`);
  lines.push(`}`);

  lines.push(``);
  lines.push(`final SpecCodec<${name}> ${name}Codec = SpecCodec<${name}>(`);

  lines.push(`  encodeJson: (obj) {`);
  lines.push(`    final w = JsonWriter();`);
  lines.push(`    _writeJson${name}(w, obj);`);
  lines.push(`    return w.toBytes();`);
  lines.push(`  },`);

  lines.push(`  encodeMsgPack: (obj) {`);
  lines.push(`    final w = MsgPackWriter();`);
  lines.push(`    _writeMsgPack${name}(w, obj);`);
  lines.push(`    return w.toBytes();`);
  lines.push(`  },`);

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
    lines.push(`        case '${prop.name}': _${prop.name} = ${readExpr(prop.type)}; break;`);
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

function collectServices(program: Program): { serviceName: string; models: Model[] }[] {
  const services = listServices(program);
  const result: { serviceName: string; models: Model[] }[] = [];

  function collectFromNs(ns: Namespace) {
    for (const [, iface] of ns.interfaces) {
      const models: Model[] = [];
      const seen = new Set<string>();
      navigateTypesInNamespace(ns, {
        model: (m: Model) => {
          if (m.name && !seen.has(m.name)) { models.push(m); seen.add(m.name); }
        },
      });
      result.push({ serviceName: iface.name, models });
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

  for (const svc of collectServices(program)) {
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
