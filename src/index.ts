import {
  createContext,
  emitFile,
  getTypeName,
  navigateTypesInNamespace,
  TypeSpecProgram,
  TypeSpecValue,
  CodeTypeEmitter,
} from "@typespec/compiler";

interface DartEmitterContext {
  outputDir: string;
}

const dartCtx = createContext<DartEmitterContext>();

function dartTypeFor(tsType: string): string {
  switch (tsType) {
    case "string": return "String";
    case "int32": case "int64": case "uint32": case "uint64": return "int";
    case "float32": case "float64": return "double";
    case "boolean": return "bool";
    case "bytes": return "Uint8List";
    default: return tsType;
  }
}

export class DartEmitter extends CodeTypeEmitter {
  async emitCode(): Promise<void> {
    const outputDir = this.options["output-dir"] ?? "specodec-dart";
    dartCtx.set({ outputDir });

    const code: string[] = [];
    code.push("import 'dart:typed_data';");
    code.push("import 'package:specodec/specodec.dart';");
    code.push("");

    for (const model of this.program.resolveTypeReferences("model")) {
      const name = getTypeName(model);
      code.push(`class ${name} {`);
      const fields: string[] = [];
      for (const prop of model.properties) {
        const fieldType = dartTypeFor(prop.typeName);
        fields.push(`  final ${fieldType} ${prop.name};`);
      }
      code.push(...fields);
      code.push("");
      code.push(`  ${name}({${fields.map((f) => f.trim().replace("final ", "")).join(", ")}});`);
      code.push("");

      code.push("  Uint8List encodeJson() {");
      code.push("    final w = JsonWriter();");
      code.push(`    w.beginObject();`);
      for (const prop of model.properties) {
        code.push(`    w.writeField("${prop.name}");`);
        code.push(`    w.writeString(${prop.name});`);
      }
      code.push("    w.endObject();");
      code.push("    return w.toBytes();");
      code.push("  }");

      code.push("");

      code.push(`  static ${name} decodeJson(Uint8List data) {`);
      code.push("    final r = JsonReader(data);");
      code.push("    r.beginObject();");
      for (const prop of model.properties) {
        code.push(`    r.readFieldName();`);
        code.push(`    final ${prop.name} = r.readString();`);
      }
      code.push("    r.endObject();");
      code.push(`    return ${name}(${model.properties.map((p) => `${p.name}: ${p.name}`).join(", ")});`);
      code.push("  }");

      code.push("}");
      code.push("");
    }

    await emitFile(this.program, {
      path: `${outputDir}/generated.dart`,
      content: code.join("\n"),
    });
  }
}

export async function $onEmit(context: TypeSpecProgram): Promise<void> {
  const emitter = new DartEmitter(context);
  await emitter.emitCode();
}
