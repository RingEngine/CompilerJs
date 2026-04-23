const OPCODES = {
  OpName: 5,
  OpMemberName: 6,
  OpEntryPoint: 15,
  OpExecutionMode: 16,
  OpTypeVoid: 19,
  OpTypeBool: 20,
  OpTypeInt: 21,
  OpTypeFloat: 22,
  OpTypeVector: 23,
  OpTypeMatrix: 24,
  OpTypeImage: 25,
  OpTypeSampler: 26,
  OpTypeSampledImage: 27,
  OpTypeArray: 28,
  OpTypeRuntimeArray: 29,
  OpTypeStruct: 30,
  OpTypePointer: 32,
  OpConstant: 43,
  OpVariable: 59,
  OpDecorate: 71,
  OpMemberDecorate: 72
};

const DECORATIONS = {
  Block: 2,
  BufferBlock: 3,
  ArrayStride: 6,
  MatrixStride: 7,
  BuiltIn: 11,
  NonWritable: 24,
  NonReadable: 25,
  Location: 30,
  Binding: 33,
  DescriptorSet: 34,
  Offset: 35
};

const STORAGE_CLASS = {
  UniformConstant: 0,
  Input: 1,
  Uniform: 2,
  Output: 3,
  PushConstant: 9,
  StorageBuffer: 12
};

const EXECUTION_MODEL = {
  Vertex: 0,
  Fragment: 4,
  GLCompute: 5
};

const EXECUTION_MODE = {
  LocalSize: 17
};

/**
 * Minimal SPIR-V reflection for the current filter compiler needs.
 *
 * It focuses on:
 * - descriptor-set bindings
 * - vertex input locations
 * - compute local size
 * - binding-level reflection for uniforms and buffers
 *
 * @param {Uint32Array} spirvWords
 * @param {'vertex'|'fragment'|'compute'} stage
 */
export function reflectSpirv(spirvWords, stage) {
  const module = parseSpirvModule(spirvWords);
  const entryPoint = selectEntryPoint(module.entryPoints, stage);
  return {
    entryPoint: {
      name: entryPoint?.name ?? 'main',
      stage,
      localSize: entryPoint?.localSize ?? null,
      inputVariables: reflectInputVariables(module, entryPoint),
      bindings: reflectBindings(module, entryPoint)
    }
  };
}

function parseSpirvModule(words) {
  const module = {
    names: new Map(),
    memberNames: new Map(),
    decorations: new Map(),
    memberDecorations: new Map(),
    constants: new Map(),
    types: new Map(),
    variables: new Map(),
    entryPoints: []
  };

  for (let index = 5; index < words.length;) {
    const instructionWord = words[index];
    const wordCount = instructionWord >>> 16;
    const opcode = instructionWord & 0xffff;
    const operands = words.subarray(index + 1, index + wordCount);

    switch (opcode) {
      case OPCODES.OpName:
        module.names.set(operands[0], decodeSpirvString(operands, 1));
        break;
      case OPCODES.OpMemberName: {
        const typeId = operands[0];
        const memberIndex = operands[1];
        const bucket = ensureNestedMap(module.memberNames, typeId);
        bucket.set(memberIndex, decodeSpirvString(operands, 2));
        break;
      }
      case OPCODES.OpEntryPoint: {
        const interfaceIds = Array.from(operands.subarray(findStringEndIndex(operands, 2)));
        module.entryPoints.push({
          executionModel: operands[0],
          id: operands[1],
          name: decodeSpirvString(operands, 2),
          interfaceIds,
          localSize: null
        });
        break;
      }
      case OPCODES.OpExecutionMode: {
        const entryPointId = operands[0];
        const mode = operands[1];
        if (mode === EXECUTION_MODE.LocalSize) {
          const entryPoint = module.entryPoints.find((item) => item.id === entryPointId);
          if (entryPoint) {
            entryPoint.localSize = {
              x: operands[2],
              y: operands[3],
              z: operands[4]
            };
          }
        }
        break;
      }
      case OPCODES.OpTypeBool:
        module.types.set(operands[0], { kind: 'bool' });
        break;
      case OPCODES.OpTypeInt:
        module.types.set(operands[0], {
          kind: operands[1] === 32 && operands[2] === 0 ? 'uint' : 'int',
          width: operands[1],
          signed: operands[2] === 1
        });
        break;
      case OPCODES.OpTypeFloat:
        module.types.set(operands[0], { kind: 'float', width: operands[1] });
        break;
      case OPCODES.OpTypeVector:
        module.types.set(operands[0], {
          kind: 'vector',
          componentTypeId: operands[1],
          componentCount: operands[2]
        });
        break;
      case OPCODES.OpTypeMatrix:
        module.types.set(operands[0], {
          kind: 'matrix',
          columnTypeId: operands[1],
          columnCount: operands[2]
        });
        break;
      case OPCODES.OpTypeImage:
        module.types.set(operands[0], {
          kind: 'image',
          sampledTypeId: operands[1]
        });
        break;
      case OPCODES.OpTypeSampler:
        module.types.set(operands[0], { kind: 'sampler' });
        break;
      case OPCODES.OpTypeSampledImage:
        module.types.set(operands[0], { kind: 'sampledImage', imageTypeId: operands[1] });
        break;
      case OPCODES.OpTypeArray:
        module.types.set(operands[0], {
          kind: 'array',
          elementTypeId: operands[1],
          lengthId: operands[2]
        });
        break;
      case OPCODES.OpTypeRuntimeArray:
        module.types.set(operands[0], {
          kind: 'runtimeArray',
          elementTypeId: operands[1]
        });
        break;
      case OPCODES.OpTypeStruct:
        module.types.set(operands[0], {
          kind: 'struct',
          memberTypeIds: Array.from(operands.subarray(1))
        });
        break;
      case OPCODES.OpTypePointer:
        module.types.set(operands[0], {
          kind: 'pointer',
          storageClass: operands[1],
          typeId: operands[2]
        });
        break;
      case OPCODES.OpConstant:
        module.constants.set(operands[1], operands[2]);
        break;
      case OPCODES.OpVariable:
        module.variables.set(operands[1], {
          resultTypeId: operands[0],
          storageClass: operands[2]
        });
        break;
      case OPCODES.OpDecorate:
        applyDecorate(module.decorations, operands[0], operands[1], operands.subarray(2));
        break;
      case OPCODES.OpMemberDecorate: {
        const bucket = ensureNestedMap(module.memberDecorations, operands[0], true);
        const memberIndex = operands[1];
        const memberDecoration = bucket.get(memberIndex) ?? {};
        applyDecoration(memberDecoration, operands[2], operands.subarray(3));
        bucket.set(memberIndex, memberDecoration);
        break;
      }
      default:
        break;
    }

    index += wordCount;
  }

  return module;
}

function reflectInputVariables(module, entryPoint) {
  if (!entryPoint) return [];

  const inputs = [];
  for (const variableId of entryPoint.interfaceIds) {
    const variable = module.variables.get(variableId);
    if (!variable || variable.storageClass !== STORAGE_CLASS.Input) continue;

    const decoration = module.decorations.get(variableId) ?? {};
    if (decoration.builtIn !== undefined) continue;
    if (decoration.location === undefined) continue;

    inputs.push({
      name: module.names.get(variableId) ?? `input_${decoration.location}`,
      location: decoration.location,
      type: describeTypeFromPointer(module, variable.resultTypeId)
    });
  }

  return inputs.sort((a, b) => a.location - b.location);
}

function reflectBindings(module, entryPoint) {
  const bindings = [];
  for (const [variableId, variable] of module.variables.entries()) {
    const decoration = module.decorations.get(variableId) ?? {};
    if (decoration.binding === undefined && decoration.descriptorSet === undefined) continue;

    const reflected = reflectBindingVariable(module, variableId, variable, decoration);
    if (Array.isArray(reflected)) {
      bindings.push(...reflected);
    } else if (reflected) {
      bindings.push(reflected);
    }
  }

  return bindings.sort(compareBindings);
}

function reflectBindingVariable(module, variableId, variable, decoration) {
  const pointerType = module.types.get(variable.resultTypeId);
  if (!pointerType || pointerType.kind !== 'pointer') return null;
  const valueType = module.types.get(pointerType.typeId);
  if (!valueType) return null;

  const base = {
    set: decoration.descriptorSet ?? 0,
    binding: decoration.binding ?? 0
  };
  const variableName = module.names.get(variableId) ?? `binding_${variableId}`;

  if (variable.storageClass === STORAGE_CLASS.UniformConstant) {
    return {
      ...base,
      name: variableName,
      type: classifyUniformConstant(module, valueType)
    };
  }

  if (variable.storageClass === STORAGE_CLASS.StorageBuffer) {
    const bufferType = describeBufferType(module, pointerType.typeId);
    return {
      ...base,
      name: variableName,
      type: 'buffer',
      access: describeStorageAccess(decoration),
      elementType: bufferType.elementType
    };
  }

  if (variable.storageClass === STORAGE_CLASS.Uniform) {
    const blockType = module.types.get(pointerType.typeId);
    if (blockType?.kind === 'struct') {
      return {
        ...base,
        name: variableName,
        type: 'uniformBlock',
        fields: describeUniformBlockFields(module, pointerType.typeId)
      };
    }

    return {
      ...base,
      name: variableName,
      type: 'uniform',
      valueType: summarizeValueType(describeType(module, pointerType.typeId))
    };
  }

  if (variable.storageClass === STORAGE_CLASS.PushConstant) {
    return {
      ...base,
      name: variableName,
      type: 'pushConstant'
    };
  }

  return null;
}

function classifyUniformConstant(module, valueType) {
  if (valueType.kind === 'sampledImage') return 'sampledImage';
  if (valueType.kind === 'sampler') return 'sampler';
  if (valueType.kind === 'image') return 'image';
  return 'uniform';
}

function describeStorageAccess(decoration) {
  if (decoration.nonReadable) return 'write';
  if (decoration.nonWritable) return 'read';
  return 'readWrite';
}

function describeTypeFromPointer(module, pointerTypeId) {
  const pointerType = module.types.get(pointerTypeId);
  if (!pointerType || pointerType.kind !== 'pointer') return { kind: 'unknown' };
  return describeType(module, pointerType.typeId);
}

function describeType(module, typeId) {
  const type = module.types.get(typeId);
  if (!type) return { kind: 'unknown' };

  if (type.kind === 'bool' || type.kind === 'int' || type.kind === 'uint' || type.kind === 'float') {
    return { kind: type.kind };
  }

  if (type.kind === 'vector') {
    return {
      kind: 'vector',
      componentCount: type.componentCount,
      componentType: describeType(module, type.componentTypeId)
    };
  }

  if (type.kind === 'matrix') {
    return {
      kind: 'matrix',
      columnCount: type.columnCount,
      columnType: describeType(module, type.columnTypeId)
    };
  }

  if (type.kind === 'sampledImage') {
    return {
      kind: 'sampledImage',
      imageType: describeType(module, type.imageTypeId)
    };
  }

  if (type.kind === 'image') {
    return {
      kind: 'image',
      sampledType: describeType(module, type.sampledTypeId)
    };
  }

  if (type.kind === 'array' || type.kind === 'runtimeArray') {
    const decoration = module.decorations.get(typeId) ?? {};
    return {
      kind: type.kind,
      elementType: describeType(module, type.elementTypeId),
      length: type.lengthId !== undefined ? module.constants.get(type.lengthId) : undefined,
      stride: decoration.arrayStride
    };
  }

  if (type.kind === 'struct') {
    const memberNameMap = module.memberNames.get(typeId) ?? new Map();
    const memberDecorationMap = module.memberDecorations.get(typeId) ?? new Map();
    return {
      kind: 'struct',
      members: type.memberTypeIds.map((memberTypeId, index) => ({
        index,
        name: memberNameMap.get(index) ?? `member${index}`,
        offset: memberDecorationMap.get(index)?.offset,
        matrixStride: memberDecorationMap.get(index)?.matrixStride,
        type: describeType(module, memberTypeId)
      }))
    };
  }

  return { kind: type.kind };
}

function applyDecorate(decorationMap, targetId, decoration, extraOperands) {
  const record = decorationMap.get(targetId) ?? {};
  applyDecoration(record, decoration, extraOperands);
  decorationMap.set(targetId, record);
}

function applyDecoration(record, decoration, extraOperands) {
  if (decoration === DECORATIONS.ArrayStride) record.arrayStride = extraOperands[0];
  if (decoration === DECORATIONS.MatrixStride) record.matrixStride = extraOperands[0];
  if (decoration === DECORATIONS.Binding) record.binding = extraOperands[0];
  if (decoration === DECORATIONS.DescriptorSet) record.descriptorSet = extraOperands[0];
  if (decoration === DECORATIONS.Offset) record.offset = extraOperands[0];
  if (decoration === DECORATIONS.Location) record.location = extraOperands[0];
  if (decoration === DECORATIONS.BuiltIn) record.builtIn = extraOperands[0];
  if (decoration === DECORATIONS.Block) record.block = true;
  if (decoration === DECORATIONS.BufferBlock) record.bufferBlock = true;
  if (decoration === DECORATIONS.NonWritable) record.nonWritable = true;
  if (decoration === DECORATIONS.NonReadable) record.nonReadable = true;
}

function ensureNestedMap(rootMap, key, createObjectValues = false) {
  let nested = rootMap.get(key);
  if (!nested) {
    nested = createObjectValues ? new Map() : new Map();
    rootMap.set(key, nested);
  }
  return nested;
}

function selectEntryPoint(entryPoints, stage) {
  const expectedModel =
    stage === 'vertex' ? EXECUTION_MODEL.Vertex :
    stage === 'fragment' ? EXECUTION_MODEL.Fragment :
    EXECUTION_MODEL.GLCompute;
  return entryPoints.find((item) => item.executionModel === expectedModel) ?? entryPoints[0] ?? null;
}

function decodeSpirvString(words, startIndex) {
  const bytes = [];
  for (let index = startIndex; index < words.length; index += 1) {
    const word = words[index];
    for (let shift = 0; shift < 32; shift += 8) {
      const byte = (word >> shift) & 0xff;
      if (byte === 0) {
        return new TextDecoder().decode(new Uint8Array(bytes));
      }
      bytes.push(byte);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function findStringEndIndex(words, startIndex) {
  for (let index = startIndex; index < words.length; index += 1) {
    const word = words[index];
    if ((word & 0xff000000) === 0 || (word & 0x00ff0000) === 0 || (word & 0x0000ff00) === 0 || (word & 0x000000ff) === 0) {
      return index + 1;
    }
  }
  return words.length;
}

function compareBindings(a, b) {
  if (a.set !== b.set) return a.set - b.set;
  if (a.binding !== b.binding) return a.binding - b.binding;
  return a.name.localeCompare(b.name);
}

function describeUniformBlockFields(module, structTypeId) {
  const blockType = describeType(module, structTypeId);
  if (blockType.kind !== 'struct') return [];

  return blockType.members.map((member) => ({
    name: member.name,
    type: summarizeValueType(member.type),
    offset: member.offset,
    size: estimateByteSize(member.type, member.matrixStride)
  }));
}

function describeBufferType(module, structTypeId) {
  const blockType = describeType(module, structTypeId);
  const firstMember = blockType.kind === 'struct' ? blockType.members[0] : null;
  const arrayType = firstMember?.type;

  return {
    elementType: summarizeValueType(arrayType?.elementType)
  };
}

function summarizeValueType(type) {
  if (!type) return 'unknown';
  if (type.kind === 'bool' || type.kind === 'int' || type.kind === 'uint' || type.kind === 'float') {
    return type.kind;
  }

  if (type.kind === 'vector') {
    const component = summarizeValueType(type.componentType);
    const prefix = component === 'float' ? 'vec' : component === 'int' ? 'ivec' : component === 'uint' ? 'uvec' : `${component}vec`;
    return `${prefix}${type.componentCount}`;
  }

  if (type.kind === 'matrix') {
    const columnType = type.columnType;
    const rowCount = columnType?.componentCount ?? 0;
    if (type.columnCount === rowCount) {
      return `mat${type.columnCount}`;
    }
    return `mat${type.columnCount}x${rowCount}`;
  }

  if (type.kind === 'array' || type.kind === 'runtimeArray') {
    return summarizeValueType(type.elementType);
  }

  if (type.kind === 'sampledImage' || type.kind === 'image' || type.kind === 'sampler') {
    return type.kind;
  }

  return type.kind;
}

function estimateByteSize(type, matrixStride) {
  if (!type) return undefined;

  if (type.kind === 'bool' || type.kind === 'int' || type.kind === 'uint' || type.kind === 'float') {
    return 4;
  }

  if (type.kind === 'vector') {
    return 4 * type.componentCount;
  }

  if (type.kind === 'matrix') {
    const stride = matrixStride ?? estimateByteSize(type.columnType);
    return stride !== undefined ? stride * type.columnCount : undefined;
  }

  if (type.kind === 'array') {
    const elementSize = estimateByteSize(type.elementType);
    if (type.stride !== undefined && type.length !== undefined) {
      return type.stride * type.length;
    }
    if (elementSize !== undefined && type.length !== undefined) {
      return elementSize * type.length;
    }
  }

  return undefined;
}
