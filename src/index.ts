import { type EmitContext, emitFile, type Model, type Type } from "@typespec/compiler";
import {
  collectServices,
  type BaseEmitterOptions,
  type FieldInfo,
  type UnionInfo,
  type UnionVariantInfo,
  extractFields,
  scalarName,
  isArrayType,
  isRecordType,
  isModelType,
  isUnionType,
  isScalarVariant,
  arrayElementType,
  recordElementType,
  toCamelCase,
  toPascalCase,
  dottedPathToSnakeCase,
  dottedPathToPascalCase,
  checkAndReportReservedKeywords,
  safeFieldName,
} from "@specodec/typespec-emitter-core";

export type EmitterOptions = BaseEmitterOptions;

function typeToKotlin(type: Type): string {
  if (isArrayType(type)) return `List<${typeToKotlin(arrayElementType(type)!)}>`;
  if (isRecordType(type)) return `Map<String, ${typeToKotlin(recordElementType(type)!)}>`;
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string":
        return "String";
      case "boolean":
        return "Boolean";
      case "int8":
        return "Byte";
      case "int16":
        return "Short";
      case "int32":
      case "integer":
        return "Int";
      case "int64":
        return "Long";
      case "uint8":
        return "UByte";
      case "uint16":
        return "UShort";
      case "uint32":
        return "UInt";
      case "uint64":
        return "ULong";
      case "float32":
        return "Float";
      case "float64":
      case "float":
      case "decimal":
        return "Double";
      case "bytes":
        return "ByteArray";
    }
  }
  if (type.kind === "Enum") return "String";
  if (isUnionType(type)) return (type as any).name || "Any";
  if (type.kind === "Model") return (type as Model).name || "Any";
  return "Any";
}

function defaultValue(type: Type): string {
  if (isArrayType(type)) return "emptyList()";
  if (isRecordType(type)) return "emptyMap()";
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string":
        return '""';
      case "boolean":
        return "false";
      case "int8":
      case "int16":
      case "int32":
      case "integer":
        return "0";
      case "int64":
        return "0L";
      case "uint8":
      case "uint16":
      case "uint32":
        return "0u";
      case "uint64":
        return "0uL";
      case "float32":
        return "0f";
      case "float64":
      case "float":
      case "decimal":
        return "0.0";
      case "bytes":
        return "byteArrayOf()";
    }
  }
  if (type.kind === "Enum") return '"";';
  return "null";
}

function writeExpr(expr: string, type: Type, w: string): string {
  if (isArrayType(type)) {
    const elem = arrayElementType(type)!;
    return [
      `${w}.beginArray(${expr}.size)`,
      `for (item in ${expr}) { ${w}.nextElement(); ${writeExpr("item", elem, w)} }`,
      `${w}.endArray()`,
    ].join("\n        ");
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type)!;
    return [
      `${w}.beginObject(${expr}.size)`,
      `for ((key, val) in ${expr}) { ${w}.writeField(key); ${writeExpr("val", elem, w)} }`,
      `${w}.endObject()`,
    ].join("\n        ");
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
        return `${w}.writeInt32(${expr}.toInt())`;
      case "int32":
      case "integer":
        return `${w}.writeInt32(${expr})`;
      case "int64":
        return `${w}.writeInt64(${expr})`;
      case "uint8":
      case "uint16":
        return `${w}.writeUint32(${expr}.toUInt())`;
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
    }
  }
  if (type.kind === "Enum") return `${w}.writeString(${expr}.toString())`;
  if (isUnionType(type) && (type as any).name) return `write${(type as any).name}(w, ${expr})`;
  if (type.kind === "Model" && (type as Model).name) return `write${(type as Model).name}(w, ${expr})`;
  return `// TODO: unknown type`;
}

function readExpr(type: Type, r: string, optional?: boolean): string {
  const n = scalarName(type);
  if (n) {
    switch (n) {
      case "string":
        return `${r}.readString()`;
      case "boolean":
        return `${r}.readBool()`;
      case "int8":
        return `${r}.readInt32().toByte()`;
      case "int16":
        return `${r}.readInt32().toShort()`;
      case "int32":
      case "integer":
        return `${r}.readInt32()`;
      case "int64":
        return `${r}.readInt64()`;
      case "uint8":
        return `${r}.readUint32().toUByte()`;
      case "uint16":
        return `${r}.readUint32().toUShort()`;
      case "uint32":
        return `${r}.readUint32()`;
      case "uint64":
        return `${r}.readUint64()`;
      case "float32":
        return `${r}.readFloat32()`;
      case "float64":
      case "float":
      case "decimal":
        return `${r}.readFloat64()`;
      case "bytes":
        return `${r}.readBytes()`;
    }
  }
  if (type.kind === "Model" && (type as Model).name) {
    const decodeCall = `${(type as Model).name}Codec.decode(${r})`;
    if (optional) return `if (${r}.isNull()) { ${r}.readNull(); null } else { ${decodeCall} }`;
    return decodeCall;
  }
  if (type.kind === "Enum") return `${r}.readString()`;
  if (isUnionType(type) && (type as any).name) {
    return `${(type as any).name}Codec.decode(${r})`;
  }
  return `null!!`;
}

function generateFieldRead(f: FieldInfo, r: string, indent: string, skipIndent: string, counter: { value: number }): { stmts: string[]; value: string } {
  const type = f.type;
  const optional = f.optional;
  const tmpVar = `tmp${counter.value++}`;
  if (isArrayType(type)) {
    const elem = arrayElementType(type)!;
    const ktElem = typeToKotlin(elem);
    const stmts: string[] = [];
    if (optional) {
      stmts.push(`${indent}var ${tmpVar} = mutableListOf<${ktElem}>()`);
      stmts.push(`${indent}if (${r}.isNull()) {`);
      stmts.push(`${indent}    ${r}.readNull()`);
      stmts.push(`${indent}} else {`);
      const ri = indent + "    ";
      stmts.push(`${ri}${r}.beginArray()`);
      stmts.push(`${ri}while (${r}.hasNextElement()) {`);
      if (isArrayType(elem) || isRecordType(elem)) {
        const inner = generateFieldRead({ name: "", type: elem, optional: false }, r, ri + "    ", "", counter);
        for (const l of inner.stmts) stmts.push(l);
        stmts.push(`${ri}    ${tmpVar}.add(${inner.value})`);
      } else {
        stmts.push(`${ri}    ${tmpVar}.add(${readExpr(elem, r)})`);
      }
      stmts.push(`${ri}}`);
      stmts.push(`${ri}${r}.endArray()`);
      stmts.push(`${indent}}`);
    } else {
      stmts.push(`${indent}val ${tmpVar} = mutableListOf<${ktElem}>()`);
      stmts.push(`${indent}${r}.beginArray()`);
      stmts.push(`${indent}while (${r}.hasNextElement()) {`);
      if (isArrayType(elem) || isRecordType(elem)) {
        const inner = generateFieldRead({ name: "", type: elem, optional: false }, r, indent + "    ", "", counter);
        for (const l of inner.stmts) stmts.push(l);
        stmts.push(`${indent}    ${tmpVar}.add(${inner.value})`);
      } else {
        stmts.push(`${indent}    ${tmpVar}.add(${readExpr(elem, r)})`);
      }
      stmts.push(`${indent}}`);
      stmts.push(`${indent}${r}.endArray()`);
    }
    return { stmts, value: tmpVar };
  }
  if (isRecordType(type)) {
    const elem = recordElementType(type)!;
    const ktElem = typeToKotlin(elem);
    const stmts: string[] = [];
    if (optional) {
      stmts.push(`${indent}var ${tmpVar} = mutableMapOf<String, ${ktElem}>()`);
      stmts.push(`${indent}if (${r}.isNull()) {`);
      stmts.push(`${indent}    ${r}.readNull()`);
      stmts.push(`${indent}} else {`);
      const ri = indent + "    ";
      stmts.push(`${ri}${r}.beginObject()`);
      stmts.push(`${ri}while (${r}.hasNextField()) {`);
      stmts.push(`${ri}    val key = ${r}.readFieldName()`);
      if (isArrayType(elem) || isRecordType(elem)) {
        const inner = generateFieldRead({ name: "", type: elem, optional: false }, r, ri + "    ", "", counter);
        for (const l of inner.stmts) stmts.push(l);
        stmts.push(`${ri}    ${tmpVar}[key] = ${inner.value}`);
      } else {
        stmts.push(`${ri}    ${tmpVar}[key] = ${readExpr(elem, r)}`);
      }
      stmts.push(`${ri}}`);
      stmts.push(`${ri}${r}.endObject()`);
      stmts.push(`${indent}}`);
    } else {
      stmts.push(`${indent}val ${tmpVar} = mutableMapOf<String, ${ktElem}>()`);
      stmts.push(`${indent}${r}.beginObject()`);
      stmts.push(`${indent}while (${r}.hasNextField()) {`);
      stmts.push(`${indent}    val key = ${r}.readFieldName()`);
      if (isArrayType(elem) || isRecordType(elem)) {
        const inner = generateFieldRead({ name: "", type: elem, optional: false }, r, indent + "    ", "", counter);
        for (const l of inner.stmts) stmts.push(l);
        stmts.push(`${indent}    ${tmpVar}[key] = ${inner.value}`);
      } else {
        stmts.push(`${indent}    ${tmpVar}[key] = ${readExpr(elem, r)}`);
      }
      stmts.push(`${indent}}`);
      stmts.push(`${indent}${r}.endObject()`);
    }
    return { stmts, value: tmpVar };
  }
  if (optional && ((type.kind === "Model" && (type as Model).name) || isUnionType(type))) {
    const stmts: string[] = [];
    stmts.push(`${indent}var ${tmpVar}: ${typeToKotlin(type)}? = null`);
    stmts.push(`${indent}if (${r}.isNull()) {`);
    stmts.push(`${indent}    ${r}.readNull()`);
    stmts.push(`${indent}} else {`);
    stmts.push(`${indent}    ${tmpVar} = ${readExpr(type, r)}`);
    stmts.push(`${indent}}`);
    return { stmts, value: tmpVar };
  }
  return { stmts: [], value: readExpr(type, r) };
}

function generateModelCode(m: Model, _pkg: string): string {
  const fields = extractFields(m);
  const optionalFields = fields.filter((f) => f.optional);
  const requiredFields = fields.filter((f) => !f.optional);
  const ktField = (f: FieldInfo) => safeFieldName("kotlin", toCamelCase(f.name));
  const lines: string[] = [];

  if (fields.length === 0) {
    lines.push(`class ${m.name}`);
  } else {
    lines.push(`data class ${m.name}(`);
    for (const f of fields) {
      if (f.optional) {
        lines.push(`    val ${ktField(f)}: ${typeToKotlin(f.type)}? = null,`);
      } else {
        lines.push(`    val ${ktField(f)}: ${typeToKotlin(f.type)},`);
      }
    }
    lines.push(`)`);
  }

  lines.push(``);
  lines.push(`fun write${m.name}(w: SpecWriter, obj: ${m.name}) {`);
  if (optionalFields.length > 0) {
    lines.push(`    var fieldCount = ${requiredFields.length}`);
    for (const f of optionalFields) lines.push(`    if (obj.${ktField(f)} != null) fieldCount++`);
    lines.push(`    w.beginObject(fieldCount)`);
  } else {
    lines.push(`    w.beginObject(${fields.length})`);
  }
  for (const f of fields) {
    if (f.optional) {
      lines.push(
        `    if (obj.${ktField(f)} != null) { w.writeField("${f.name}"); ${writeExpr(`obj.${ktField(f)}`, f.type, "w")} }`,
      );
    } else {
      lines.push(`    w.writeField("${f.name}"); ${writeExpr(`obj.${ktField(f)}`, f.type, "w")}`);
    }
  }
  lines.push(`    w.endObject()`);
  lines.push(`}`);

  lines.push(``);
  lines.push(`val ${m.name}Codec: SpecCodec<${m.name}> = SpecCodec(`);
  lines.push(`    encode = { w, obj -> write${m.name}(w, obj) },`);
  lines.push(`    decode = { r ->`);
  for (const f of fields) {
    const fld = toCamelCase(f.name);
    if (isUnionType(f.type)) {
      const unionName = (f.type as any).name;
      lines.push(`        var ${fld}Val: ${typeToKotlin(f.type)} = ${unionName}.${unionName}Undefined`);
    } else if (f.optional || isModelType(f.type)) {
      lines.push(`        var ${fld}Val: ${typeToKotlin(f.type)}? = null`);
    } else {
      lines.push(`        var ${fld}Val: ${typeToKotlin(f.type)} = ${defaultValue(f.type)}`);
    }
  }
  lines.push(`        r.beginObject()`);
  lines.push(`        while (r.hasNextField()) {`);
  lines.push(`            when (r.readFieldName()) {`);
  const _counter = { value: 0 };
  for (const f of fields) {
    const fld = toCamelCase(f.name);
    const read = generateFieldRead(f, "r", "                    ", "", _counter);
    if (read.stmts.length > 0) {
      lines.push(`                "${f.name}" -> {`);
      for (const l of read.stmts) lines.push(l);
      lines.push(`                    ${fld}Val = ${read.value}`);
      lines.push(`                }`);
    } else {
      lines.push(`                "${f.name}" -> ${fld}Val = ${read.value}`);
    }
  }
  lines.push(`                else -> r.skip()`);
  lines.push(`            }`);
  lines.push(`        }`);
  lines.push(`        r.endObject()`);
  const ctorArgs = fields
    .map((f) => {
      const fld = toCamelCase(f.name);
      return !f.optional && isModelType(f.type) ? `${fld} = ${fld}Val!!` : `${fld} = ${fld}Val`;
    })
    .join(", ");
  lines.push(`        ${m.name}(${ctorArgs})`);
  lines.push(`    }`);
  lines.push(`)`);

  return lines.join("\n");
}

function generateUnionCode(u: UnionInfo, L: string[]): void {
  const unionName = u.name;
  const variantName = (v: UnionVariantInfo) => unionName + toPascalCase(v.name);

  L.push(`sealed class ${unionName} {`);
  L.push(`    object ${unionName}Undefined : ${unionName}()`);
  for (const v of u.variants) {
    const vn = variantName(v);
    const ktType = typeToKotlin(v.type);
    L.push(`    data class ${vn}(val value: ${ktType}) : ${unionName}()`);
  }
  L.push(`}`);
  L.push(``);

  L.push(`fun write${unionName}(w: SpecWriter, obj: ${unionName}) {`);
  L.push(`    w.beginObject(1)`);
  L.push(`    when (obj) {`);
  L.push(`        is ${unionName}.${unionName}Undefined -> throw IllegalArgumentException("cannot encode Undefined for ${unionName}")`);
  for (const v of u.variants) {
    const vn = variantName(v);
    L.push(`        is ${unionName}.${vn} -> { w.writeField("${v.name}"); ${writeExpr("obj.value", v.type, "w")} }`);
  }
  L.push(`    }`);
  L.push(`    w.endObject()`);
  L.push(`}`);
  L.push(``);

  L.push(`fun decode${unionName}(r: SpecReader): ${unionName} {`);
  L.push(`    r.beginObject()`);
  L.push(`    if (!r.hasNextField()) { r.endObject(); throw IllegalArgumentException("empty union") }`);
  L.push(`    val field = r.readFieldName()`);
  L.push(`    var result: ${unionName} = ${unionName}.${unionName}Undefined`);
  L.push(`    when (field) {`);
  for (const v of u.variants) {
    const vn = variantName(v);
    L.push(`        "${v.name}" -> result = ${unionName}.${vn}(${readExpr(v.type, "r")})`);
  }
  L.push(`        else -> throw IllegalArgumentException("unknown variant \$field")`);
  L.push(`    }`);
  L.push(`    while (r.hasNextField()) { r.readFieldName(); r.skip() }`);
  L.push(`    r.endObject()`);
  L.push(`    return result`);
  L.push(`}`);
  L.push(``);

  L.push(`val ${unionName}Codec = SpecCodec<${unionName}>(::write${unionName}, ::decode${unionName})`);
}

export async function $onEmit(context: EmitContext<EmitterOptions>) {
  const program = context.program;
  const outputDir = context.emitterOutputDir;
  const ignoreReservedKeywords = context.options["ignore-reserved-keywords"] ?? false;
  const services = collectServices(program);

  if (checkAndReportReservedKeywords(program, services, ignoreReservedKeywords)) return;

  const modelNs = new Map<string, string>();
  for (const s of services) {
    for (const m of s.models) { if (m.name) modelNs.set(m.name, s.serviceName); }
    for (const e of s.enums) { if (e.name) modelNs.set(e.name, s.serviceName); }
    for (const u of s.unions) { if (u.name) modelNs.set(u.name, s.serviceName); }
  }

  for (const svc of services) {
    const pkg = dottedPathToSnakeCase(svc.serviceName);
    const lines: string[] = [];

    const xrefNs = new Set<string>();
    for (const m of svc.models) {
      if (!m.name) continue;
      for (const f of extractFields(m)) {
        const collectX = (t: Type) => {
          if ((t.kind === "Model" || t.kind === "Enum") && (t as any).name) {
            const ns = modelNs.get((t as any).name);
            if (ns && ns !== svc.serviceName) xrefNs.add(ns);
          }
          if (isArrayType(t)) collectX(arrayElementType(t)!);
          if (isRecordType(t)) collectX(recordElementType(t)!);
        };
        collectX(f.type);
      }
    }
    for (const u of svc.unions) {
      for (const v of u.variants) {
        const collectX = (t: Type) => {
          if ((t.kind === "Model" || t.kind === "Enum") && (t as any).name) {
            const ns = modelNs.get((t as any).name);
            if (ns && ns !== svc.serviceName) xrefNs.add(ns);
          }
          if (isArrayType(t)) collectX(arrayElementType(t)!);
          if (isRecordType(t)) collectX(recordElementType(t)!);
        };
        collectX(v.type);
      }
    }

    lines.push("// Generated by @specodec/typespec-emitter-kotlin. DO NOT EDIT.");
    lines.push(`package ${pkg}`);
    lines.push(``);
    lines.push(`import specodec.*`);
    for (const ns of [...xrefNs].sort()) {
      lines.push(`import ${dottedPathToSnakeCase(ns)}.*`);
    }
    lines.push(``);
    for (const m of svc.models) {
      if (!m.name) continue;
      lines.push(generateModelCode(m, pkg));
      lines.push(``);
    }
    for (const u of svc.unions) {
      generateUnionCode(u, lines);
      lines.push(``);
    }
    const fileName = `${dottedPathToPascalCase(svc.serviceName)}Types.kt`;
    await emitFile(program, { path: `${outputDir}/${fileName}`, content: lines.join("\n") });
  }
}
