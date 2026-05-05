import {
  EmitContext,
  emitFile,
  Model,
  Type,
} from "@typespec/compiler";
import {
  collectServices,
  ServiceInfo,
  BaseEmitterOptions,
  FieldInfo,
  extractFields,
  scalarName,
  isArrayType,
  isRecordType,
  isModelType,
  arrayElementType,
  recordElementType,
  toPascalCase,
  toSnakeCase,
  dottedPathToSnakeCase,
  dottedPathToPascalCase,
  checkAndReportReservedKeywords,
} from "@specodec/typespec-emitter-core";

export type EmitterOptions = BaseEmitterOptions;

function typeToKotlin(type: Type): string {
  if (isArrayType(type)) return `List<${typeToKotlin(arrayElementType(type))}>`;
  if (isRecordType(type)) return `Map<String, ${typeToKotlin(recordElementType(type))}>`;
  const n = scalarName(type);
  if (n) {
    switch (n) {
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
  if (isRecordType(type)) return "emptyMap()";
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string": return '""';
      case "boolean": return "false";
      case "int8": case "int16": case "int32": case "integer": return "0";
      case "int64": return "0L";
      case "uint8": case "uint16": case "uint32": return "0u";
      case "uint64": return "0uL";
      case "float32": return "0f";
      case "float64": case "float": case "decimal": return "0.0";
      case "bytes": return "byteArrayOf()";
    }
  }
  return "null";
}

function writeExpr(expr: string, type: Type, w: string): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    return [
      `${w}.beginArray(${expr}.size)`,
      `for (item in ${expr}) { ${w}.nextElement(); ${writeExpr("item", elem, w)} }`,
      `${w}.endArray()`,
    ].join("\n        ");
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type);
    return [
      `${w}.beginObject(${expr}.size)`,
      `for ((key, val) in ${expr}) { ${w}.writeField(key); ${writeExpr("val", elem, w)} }`,
      `${w}.endObject()`,
    ].join("\n        ");
  }
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string": return `${w}.writeString(${expr})`;
      case "boolean": return `${w}.writeBool(${expr})`;
      case "int8": case "int16": return `${w}.writeInt32(${expr}.toInt())`;
      case "int32": case "integer": return `${w}.writeInt32(${expr})`;
      case "int64": return `${w}.writeInt64(${expr})`;
      case "uint8": case "uint16": return `${w}.writeUint32(${expr}.toUInt())`;
      case "uint32": return `${w}.writeUint32(${expr})`;
      case "uint64": return `${w}.writeUint64(${expr})`;
      case "float32": return `${w}.writeFloat32(${expr})`;
      case "float64": case "float": case "decimal": return `${w}.writeFloat64(${expr})`;
      case "bytes": return `${w}.writeBytes(${expr})`;
    }
  }
  if (type.kind === "Model" && (type as Model).name) return `write${(type as Model).name}(w, ${expr})`;
  return `// TODO: unknown type`;
}

function readExpr(type: Type, r: string, optional?: boolean): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type);
    const ktElem = typeToKotlin(elem);
    return `run { val list = mutableListOf<${ktElem}>(); ${r}.beginArray(); while (${r}.hasNextElement()) { list.add(${readExpr(elem, r)}) }; ${r}.endArray(); list }`;
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type);
    const ktElem = typeToKotlin(elem);
    return `run { val map = mutableMapOf<String, ${ktElem}>(); ${r}.beginObject(); while (${r}.hasNextField()) { val key = ${r}.readFieldName(); map[key] = ${readExpr(elem, r)} }; ${r}.endObject(); map }`;
  }
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string": return `${r}.readString()`;
      case "boolean": return `${r}.readBool()`;
      case "int8": return `${r}.readInt32().toByte()`;
      case "int16": return `${r}.readInt32().toShort()`;
      case "int32": case "integer": return `${r}.readInt32()`;
      case "int64": return `${r}.readInt64()`;
      case "uint8": return `${r}.readUint32().toUByte()`;
      case "uint16": return `${r}.readUint32().toUShort()`;
      case "uint32": return `${r}.readUint32()`;
      case "uint64": return `${r}.readUint64()`;
      case "float32": return `${r}.readFloat32()`;
      case "float64": case "float": case "decimal": return `${r}.readFloat64()`;
      case "bytes": return `${r}.readBytes()`;
    }
  }
  if (type.kind === "Model" && (type as Model).name) {
    const decodeCall = `${(type as Model).name}Codec.decode(${r})`;
    if (optional) return `if (${r}.isNull()) { ${r}.readNull(); null } else { ${decodeCall} }`;
    return decodeCall;
  }
  return `null!!`;
}

function generateModelCode(m: Model, pkg: string): string {
  const fields = extractFields(m);
  const optionalFields = fields.filter(f => f.optional);
  const requiredFields = fields.filter(f => !f.optional);
  const lines: string[] = [];

  if (fields.length === 0) {
    lines.push(`class ${m.name}`);
  } else {
    lines.push(`data class ${m.name}(`);
    for (const f of fields) {
      if (f.optional) {
        lines.push(`    val ${f.name}: ${typeToKotlin(f.type)}? = null,`);
      } else {
        lines.push(`    val ${f.name}: ${typeToKotlin(f.type)},`);
      }
    }
    lines.push(`)`);
  }

  lines.push(``);
  lines.push(`private fun write${m.name}(w: SpecWriter, obj: ${m.name}) {`);
  if (optionalFields.length > 0) {
    lines.push(`    var fieldCount = ${requiredFields.length}`);
    for (const f of optionalFields) lines.push(`    if (obj.${f.name} != null) fieldCount++`);
    lines.push(`    w.beginObject(fieldCount)`);
  } else {
    lines.push(`    w.beginObject(${fields.length})`);
  }
  for (const f of fields) {
    if (f.optional) {
      lines.push(`    if (obj.${f.name} != null) { w.writeField("${f.name}"); ${writeExpr(`obj.${f.name}`, f.type, "w")} }`);
    } else {
      lines.push(`    w.writeField("${f.name}"); ${writeExpr(`obj.${f.name}`, f.type, "w")}`);
    }
  }
  lines.push(`    w.endObject()`);
  lines.push(`}`);

  lines.push(``);
  lines.push(`val ${m.name}Codec: SpecCodec<${m.name}> = SpecCodec(`);
  lines.push(`    encode = { w, obj -> write${m.name}(w, obj) },`);
  lines.push(`    decode = { r ->`);
  for (const f of fields) {
    if (f.optional || isModelType(f.type)) {
      lines.push(`        var ${f.name}Val: ${typeToKotlin(f.type)}? = null`);
    } else {
      lines.push(`        var ${f.name}Val: ${typeToKotlin(f.type)} = ${defaultValue(f.type)}`);
    }
  }
  lines.push(`        r.beginObject()`);
  lines.push(`        while (r.hasNextField()) {`);
  lines.push(`            when (r.readFieldName()) {`);
  for (const f of fields) {
    lines.push(`                "${f.name}" -> ${f.name}Val = ${readExpr(f.type, "r", f.optional)}`);
  }
  lines.push(`                else -> r.skip()`);
  lines.push(`            }`);
  lines.push(`        }`);
  lines.push(`        r.endObject()`);
  const ctorArgs = fields.map(f => (!f.optional && isModelType(f.type)) ? `${f.name} = ${f.name}Val!!` : `${f.name} = ${f.name}Val`).join(", ");
  lines.push(`        ${m.name}(${ctorArgs})`);
  lines.push(`    }`);
  lines.push(`)`);

  return lines.join("\n");
}

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const ignoreReservedKeywords = context.options["ignore-reserved-keywords"] ?? false;
  const services = collectServices(program);

  if (checkAndReportReservedKeywords(program, services, ignoreReservedKeywords)) return;

  for (const svc of services) {
    const pkg = dottedPathToSnakeCase(svc.serviceName);
    const lines: string[] = [];
    lines.push("// Generated by @specodec/typespec-emitter-kotlin. DO NOT EDIT.");
    lines.push(`package ${pkg}`);
    lines.push(``);
    lines.push(`import specodec.*`);
    lines.push(``);
    for (const m of svc.models) {
      if (!m.name) continue;
      lines.push(generateModelCode(m, pkg));
      lines.push(``);
    }
    // Kotlin/Swift use PascalCase file names
    const fileName = `${dottedPathToPascalCase(svc.serviceName)}Types.kt`;
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: lines.join("\n") });
  }
}
