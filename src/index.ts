import {
  EmitContext,
  emitFile,
  listServices,
  getNamespaceFullName,
  navigateTypesInNamespace,
  Model,
  Namespace,
  Interface,
  Program,
  Type,
  Scalar,
} from "@typespec/compiler";

export type EmitterOptions = {
  "emitter-output-dir": string;
};

interface FieldInfo {
  name: string;
  type: Type;
  optional: boolean;
}

interface ServiceInfo {
  namespace: Namespace;
  iface: Interface;
  serviceName: string;
  serviceFQN: string;
  models: Model[];
}

function extractFields(model: Model): FieldInfo[] {
  const fields: FieldInfo[] = [];
  for (const [name, prop] of model.properties) {
    fields.push({ name, type: prop.type, optional: prop.optional ?? false });
  }
  return fields;
}

function isStringType(type: Type): boolean {
  if (type.kind === "Scalar") {
    const s = type as Scalar;
    if (s.name === "string") return true;
    if (s.baseScalar) return isStringType(s.baseScalar);
  }
  if (type.kind === "Intrinsic") return (type as any).name === "string";
  return false;
}

function scalarName(type: Type): string | null {
  if (type.kind !== "Scalar") return null;
  const s = type as Scalar;
  const known = ["int8","int16","int32","int64","uint8","uint16","uint32","uint64","integer",
                  "float","float32","float64","decimal","boolean","bytes","string"];
  if (known.includes(s.name)) return s.name;
  if (s.baseScalar) return scalarName(s.baseScalar);
  return s.name;
}

function isArrayType(type: Type): boolean {
  return type.kind === "Model" && !!(type as Model).indexer;
}

function arrayElementType(type: Type): Type {
  if (type.kind === "Model" && (type as Model).indexer) return (type as Model).indexer!.value;
  return type;
}

function typeToKotlin(type: Type): string {
  if (isArrayType(type)) return `List<${typeToKotlin(arrayElementType(type))}>`;
  const sn = scalarName(type);
  if (sn) {
    switch (sn) {
      case "string": return "String";
      case "boolean": return "Boolean";
      case "int8": return "Byte";
      case "int16": return "Short";
      case "int32": case "integer": return "Int";
      case "int64": return "Long";
      case "uint8": return "UByte";
      case "uint16": return "UShort";
      case "uint32": return "UInt";
      case "uint64": return "ULong";
      case "float32": return "Float";
      case "float64": case "float": case "decimal": return "Double";
      case "bytes": return "ByteArray";
    }
  }
  if (type.kind === "Model") return (type as Model).name || "Any";
  return "Any";
}

function defaultValue(type: Type): string {
  if (isArrayType(type)) return "emptyList()";
  const sn = scalarName(type);
  if (sn) {
    switch (sn) {
      case "string": return '""';
      case "boolean": return "false";
      case "int8": case "int16": case "int32": case "integer": return "0";
      case "int64": return "0L";
      case "uint8": case "uint16": case "uint32": return "0";
      case "uint64": return "0L";
      case "float32": return "0f";
      case "float64": case "float": case "decimal": return "0.0";
      case "bytes": return "byteArrayOf()";
    }
  }
  return "null!!";
}

function writeJsonExpr(expr: string, type: Type, w: string): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    return [
      `${w}.beginArray(${expr}.size)`,
      `for (_e in ${expr}) { ${w}.nextElement(); ${writeJsonExpr("_e", elem, w)} }`,
      `${w}.endArray()`,
    ].join("\n        ");
  }
  const sn = scalarName(type);
  if (sn) {
    switch (sn) {
      case "string": return `${w}.writeString(${expr})`;
      case "boolean": return `${w}.writeBool(${expr})`;
      case "int8": case "int16": case "int32": case "integer": return `${w}.writeInt32(${expr}.toInt())`;
      case "int64": return `${w}.writeInt64(${expr})`;
      case "uint8": case "uint16": case "uint32": return `${w}.writeUint32(${expr}.toLong())`;
      case "uint64": return `${w}.writeUint64(${expr}.toLong())`;
      case "float32": return `${w}.writeFloat32(${expr})`;
      case "float64": case "float": case "decimal": return `${w}.writeFloat64(${expr})`;
      case "bytes": return `${w}.writeBytes(${expr})`;
    }
  }
  return `// TODO: nested model`;
}

function writeMsgPackExpr(expr: string, type: Type, w: string): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    return [
      `${w}.beginArray(${expr}.size)`,
      `for (_e in ${expr}) { ${w}.nextElement(); ${writeMsgPackExpr("_e", elem, w)} }`,
      `${w}.endArray()`,
    ].join("\n        ");
  }
  const sn = scalarName(type);
  if (sn) {
    switch (sn) {
      case "string": return `${w}.writeString(${expr})`;
      case "boolean": return `${w}.writeBool(${expr})`;
      case "int8": case "int16": case "int32": case "integer": return `${w}.writeInt32(${expr}.toInt())`;
      case "int64": return `${w}.writeInt64(${expr})`;
      case "uint8": case "uint16": case "uint32": return `${w}.writeUint32(${expr}.toLong())`;
      case "uint64": return `${w}.writeUint64(${expr}.toLong())`;
      case "float32": return `${w}.writeFloat32(${expr})`;
      case "float64": case "float": case "decimal": return `${w}.writeFloat64(${expr})`;
      case "bytes": return `${w}.writeBytes(${expr})`;
    }
  }
  return `// TODO: nested model`;
}

function readExpr(type: Type, r: string): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    const ktElem = typeToKotlin(elem);
    return `run { val _list = mutableListOf<${ktElem}>(); ${r}.beginArray(); while (${r}.hasNextElement()) { _list.add(${readExpr(elem, r)}) }; ${r}.endArray(); _list }`;
  }
  const sn = scalarName(type);
  if (sn) {
    switch (sn) {
      case "string": return `${r}.readString()`;
      case "boolean": return `${r}.readBool()`;
      case "int8": case "int16": case "int32": case "integer": return `${r}.readInt32()`;
      case "int64": return `${r}.readInt64()`;
      case "uint8": case "uint16": case "uint32": return `${r}.readUint32()`;
      case "uint64": return `${r}.readUint64()`;
      case "float32": return `${r}.readFloat32()`;
      case "float64": case "float": case "decimal": return `${r}.readFloat64()`;
      case "bytes": return `${r}.readBytes()`;
    }
  }
  if (type.kind === "Model") {
    const name = (type as Model).name;
    return `${name}Codec.decode(${r})`;
  }
  return `null!!`;
}

function generateModelCode(m: Model, pkg: string): string {
  const fields = extractFields(m);
  const lines: string[] = [];

  lines.push(`data class ${m.name}(`);
  for (const f of fields) {
    const kt = typeToKotlin(f.type);
    if (f.optional) {
      lines.push(`    val ${f.name}: ${kt}? = null,`);
    } else {
      lines.push(`    val ${f.name}: ${kt},`);
    }
  }
  lines.push(`)`);
  lines.push(``);

  const requiredFields = fields.filter(f => !f.optional);
  const optionalFields = fields.filter(f => f.optional);

  lines.push(`val ${m.name}Codec: SpecCodec<${m.name}> = SpecCodec(`);

  lines.push(`    encodeJson = { obj ->`);
  lines.push(`        val w = JsonWriter()`);
  lines.push(`        w.beginObject()`);
  for (const f of requiredFields) {
    lines.push(`        w.writeField("${f.name}"); ${writeJsonExpr(`obj.${f.name}`, f.type, "w")}`);
  }
  for (const f of optionalFields) {
    lines.push(`        if (obj.${f.name} != null) { w.writeField("${f.name}"); ${writeJsonExpr(`obj.${f.name}`, f.type, "w")} }`);
  }
  lines.push(`        w.endObject()`);
  lines.push(`        w.toBytes()`);
  lines.push(`    },`);

  lines.push(`    encodeMsgPack = { obj ->`);
  if (optionalFields.length > 0) {
    lines.push(`        var _n = ${requiredFields.length}`);
    for (const f of optionalFields) {
      lines.push(`        if (obj.${f.name} != null) _n++`);
    }
  } else {
    lines.push(`        val _n = ${requiredFields.length}`);
  }
  lines.push(`        val w = MsgPackWriter()`);
  lines.push(`        w.beginObject(_n)`);
  for (const f of requiredFields) {
    lines.push(`        w.writeField("${f.name}"); ${writeMsgPackExpr(`obj.${f.name}`, f.type, "w")}`);
  }
  for (const f of optionalFields) {
    lines.push(`        if (obj.${f.name} != null) { w.writeField("${f.name}"); ${writeMsgPackExpr(`obj.${f.name}`, f.type, "w")} }`);
  }
  lines.push(`        w.endObject()`);
  lines.push(`        w.toBytes()`);
  lines.push(`    },`);

  lines.push(`    decode = { r ->`);
  for (const f of fields) {
    if (f.optional) {
      lines.push(`        var _${f.name}: ${typeToKotlin(f.type)}? = null`);
    } else {
      lines.push(`        var _${f.name}: ${typeToKotlin(f.type)} = ${defaultValue(f.type)}`);
    }
  }
  lines.push(`        r.beginObject()`);
  lines.push(`        while (r.hasNextField()) {`);
  lines.push(`            when (r.readFieldName()) {`);
  for (const f of fields) {
    lines.push(`                "${f.name}" -> _${f.name} = ${readExpr(f.type, "r")}`);
  }
  lines.push(`                else -> r.skip()`);
  lines.push(`            }`);
  lines.push(`        }`);
  lines.push(`        r.endObject()`);
  const ctorArgs = fields.map(f => `${f.name} = _${f.name}`).join(", ");
  lines.push(`        ${m.name}(${ctorArgs})`);
  lines.push(`    }`);
  lines.push(`)`);

  return lines.join("\n");
}

function collectServices(program: Program): ServiceInfo[] {
  const services = listServices(program);
  const result: ServiceInfo[] = [];
  function collectFromNs(ns: Namespace) {
    for (const [, iface] of ns.interfaces) {
      const nsFQN = getNamespaceFullName(ns);
      const models: Model[] = [];
      const seen = new Set<string>();
      navigateTypesInNamespace(ns, {
        model: (m: Model) => {
          if (m.name && !seen.has(m.name)) { models.push(m); seen.add(m.name); }
        }
      });
      result.push({ namespace: ns, iface, serviceName: iface.name, serviceFQN: `${nsFQN}.${iface.name}`, models });
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

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const services = collectServices(program);
  for (const svc of services) {
    const toSnake = (s: string) => s.replace(/([A-Z])/g, (m, c, i) => (i ? "_" : "") + c.toLowerCase());
    const pkg = svc.namespace.name?.toLowerCase().replace(/[^a-z0-9]/g, "") ?? "svc";
    const lines: string[] = [];
    lines.push("// Generated by @specodec/typespec-specodec-kotlin. DO NOT EDIT.");
    lines.push(`package ${pkg}`);
    lines.push(``);
    lines.push(`import specodec.*`);
    lines.push(``);
    for (const m of svc.models) {
      if (!m.name) continue;
      lines.push(generateModelCode(m, pkg));
      lines.push(``);
    }
    const fileName = svc.serviceName + "Types.kt";
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: lines.join("\n") });
  }
}
