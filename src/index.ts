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
    const name = s.name;
    switch (name) {
      case "string": return "String";
      case "boolean": return "bool";
      case "int8": case "int16": case "int32": case "integer":
      case "int64": case "uint8": case "uint16": case "uint32": case "uint64":
        return "int";
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

function writeExpr(type: Type, expr: string): string {
  if (type.kind === "Scalar") {
    const s = type as Scalar;
    switch (s.name) {
      case "string": return `w.writeString(${expr})`;
      case "boolean": return `w.writeBool(${expr})`;
      case "int8": case "int16": case "int32": case "integer":
        return `w.writeInt32(${expr})`;
      case "int64": return `w.writeInt64(${expr})`;
      case "uint8": case "uint16": case "uint32":
        return `w.writeUint32(${expr})`;
      case "uint64": return `w.writeUint64(${expr})`;
      case "float32": return `w.writeFloat32(${expr})`;
      case "float64": case "float": case "decimal":
        return `w.writeFloat64(${expr})`;
      case "bytes": return `w.writeBytes(${expr})`;
      default: return `w.writeString(${expr}.toString())`;
    }
  }
  if (type.kind === "Model") {
    const m = type as Model;
    if (m.indexer) {
      const elemType = getArrayElementType(type);
      const writeElem = writeExpr(elemType, "_e");
      return `w.beginArray(${expr}.length); for (final _e in ${expr}) { w.nextElement(); ${writeElem}; } w.endArray()`;
    }
  }
  return `w.writeString(${expr}.toString())`;
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
  if (type.kind === "Model") {
    const m = type as Model;
    if (m.indexer) {
      const elemType = getArrayElementType(type);
      const elemDartType = dartBaseType(elemType);
      const elemRead = readExpr(elemType);
      return `() { final _list = <${elemDartType}>[]; r.beginArray(); while (r.hasNextElement()) { _list.add(${elemRead}); } r.endArray(); return _list; }()`;
    }
    return `${m.name}Codec.decode(r)`;
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
      case "int64": case "uint8": case "uint16": case "uint32": case "uint64":
        return "0";
      case "float32": case "float64": case "float": case "decimal":
        return "0.0";
      case "bytes": return "Uint8List(0)";
      default: return "''";
    }
  }
  if (type.kind === "Model") {
    const m = type as Model;
    if (m.indexer) return "[]";
  }
  return "null";
}

function getScalarName(type: Type): string | null {
  if (type.kind === "Scalar") return (type as Scalar).name;
  return null;
}

function emitModel(model: Model): string {
  const name = model.name;
  const props = [...model.properties.values()];

  const lines: string[] = [];

  lines.push(`class ${name} {`);
  for (const prop of props) {
    const dartType = dartTypeFor(prop.type, prop.optional);
    lines.push(`  final ${dartType} ${prop.name};`);
  }
  const ctorParams = props
    .map((p) => {
      const dartType = dartTypeFor(p.type, p.optional);
      if (p.optional) return `this.${p.name}`;
      return `required this.${p.name}`;
    })
    .join(", ");
  lines.push(`  const ${name}({${ctorParams}});`);
  lines.push(`}`);
  lines.push(``);

  const codecLines: string[] = [];
  codecLines.push(`final ${name}Codec = SpecCodec<${name}>(`);

  codecLines.push(`  encodeJson: (obj) {`);
  codecLines.push(`    final w = JsonWriter();`);
  codecLines.push(`    w.beginObject();`);
  for (const prop of props) {
    if (prop.optional) {
      codecLines.push(`    if (obj.${prop.name} != null) { w.writeField('${prop.name}'); ${writeExpr(prop.type, `obj.${prop.name}!`)}; }`);
    } else {
      codecLines.push(`    w.writeField('${prop.name}'); ${writeExpr(prop.type, `obj.${prop.name}`)};`);
    }
  }
  codecLines.push(`    w.endObject();`);
  codecLines.push(`    return w.toBytes();`);
  codecLines.push(`  },`);

  codecLines.push(`  encodeMsgPack: (obj) {`);
  const requiredCount = props.filter((p) => !p.optional).length;
  const optionalProps = props.filter((p) => p.optional);
  if (optionalProps.length > 0) {
    codecLines.push(`    var _n = ${requiredCount};`);
    for (const prop of optionalProps) {
      codecLines.push(`    if (obj.${prop.name} != null) _n++;`);
    }
    codecLines.push(`    final w = MsgPackWriter();`);
    codecLines.push(`    w.beginObject(_n);`);
  } else {
    codecLines.push(`    final w = MsgPackWriter();`);
    codecLines.push(`    w.beginObject(${requiredCount});`);
  }
  for (const prop of props) {
    if (prop.optional) {
      codecLines.push(`    if (obj.${prop.name} != null) { w.writeField('${prop.name}'); ${writeExpr(prop.type, `obj.${prop.name}!`)}; }`);
    } else {
      codecLines.push(`    w.writeField('${prop.name}'); ${writeExpr(prop.type, `obj.${prop.name}`)};`);
    }
  }
  codecLines.push(`    w.endObject();`);
  codecLines.push(`    return w.toBytes();`);
  codecLines.push(`  },`);

  codecLines.push(`  decode: (r) {`);
  for (const prop of props) {
    if (prop.optional) {
      const dartType = dartBaseType(prop.type);
      codecLines.push(`    ${dartType}? _${prop.name};`);
    } else {
      const dartType = dartBaseType(prop.type);
      codecLines.push(`    ${dartType} _${prop.name} = ${defaultVal(prop.type)};`);
    }
  }
  codecLines.push(`    r.beginObject();`);
  codecLines.push(`    while (r.hasNextField()) {`);
  codecLines.push(`      switch (r.readFieldName()) {`);
  for (const prop of props) {
    codecLines.push(`        case '${prop.name}': _${prop.name} = ${readExpr(prop.type)}; break;`);
  }
  codecLines.push(`        default: r.skip();`);
  codecLines.push(`      }`);
  codecLines.push(`    }`);
  codecLines.push(`    r.endObject();`);
  const ctorArgs = props.map((p) => `${p.name}: _${p.name}`).join(", ");
  codecLines.push(`    return ${name}(${ctorArgs});`);
  codecLines.push(`  },`);
  codecLines.push(`);`);
  codecLines.push(``);

  return [...lines, ...codecLines].join("\n");
}

function collectModels(program: Program): Model[] {
  const models: Model[] = [];
  const seen = new Set<string>();
  for (const [ns] of program.getGlobalNamespaceType().namespaces) {
    const nsType = program.getGlobalNamespaceType().namespaces.get(ns)!;
    for (const [, model] of nsType.models) {
      if (!seen.has(model.name)) {
        seen.add(model.name);
        models.push(model);
      }
    }
  }
  for (const [, model] of program.getGlobalNamespaceType().models) {
    if (!seen.has(model.name)) {
      seen.add(model.name);
      models.push(model);
    }
  }
  return models;
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
