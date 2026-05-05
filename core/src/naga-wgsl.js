import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const OPCODES = {
  OpName: 5,
  OpEntryPoint: 15,
  OpDecorate: 71,
  OpTypeImage: 25,
  OpTypeSampler: 26,
  OpTypeSampledImage: 27,
  OpTypePointer: 32,
  OpVariable: 59,
  OpLoad: 61,
  OpSampledImage: 86,
  OpFunction: 54
};

const DECORATIONS = {
  Binding: 33,
  DescriptorSet: 34
};

const STORAGE_CLASS = {
  UniformConstant: 0
};

export async function translateSpirvToWgsl({ spirv, stage, bindings }) {
  const bindingPlan = buildWebGpuBindingPlan(bindings);
  const transformed = transformSpirvForWebGpu(spirv, bindingPlan);
  const code = await runNagaWgsl(transformed.words, stage);
  return {
    code,
    lineMap: [],
    entryPoint: 'main',
    bindings: applyWebGpuBindingPlan(bindings, bindingPlan)
  };
}

export function buildWebGpuBindingPlan(bindings = []) {
  const ordered = [...bindings].sort((left, right) =>
    (left.set ?? 0) - (right.set ?? 0)
      || (left.binding ?? 0) - (right.binding ?? 0)
      || String(left.name ?? '').localeCompare(String(right.name ?? ''))
  );
  const nextSamplerBindingBySet = new Map();
  const bySlot = new Map();
  const byName = new Map();

  for (const binding of ordered) {
    const set = binding.set ?? 0;
    const bindingIndex = binding.binding ?? 0;
    nextSamplerBindingBySet.set(set, Math.max(
      nextSamplerBindingBySet.get(set) ?? 0,
      bindingIndex + 1
    ));
  }

  for (const binding of ordered) {
    const set = binding.set ?? 0;
    const bindingIndex = binding.binding ?? 0;
    const entry = {
      set,
      originalBinding: bindingIndex,
      binding: bindingIndex
    };
    if (binding.type === 'sampledImage') {
      const samplerBinding = nextSamplerBindingBySet.get(set) ?? bindingIndex + 1;
      entry.samplerBinding = samplerBinding;
      nextSamplerBindingBySet.set(set, samplerBinding + 1);
    }
    bySlot.set(`${set}:${bindingIndex}`, entry);
    byName.set(binding.name, entry);
  }

  return { bySlot, byName };
}

export function applyWebGpuBindingPlan(bindings = [], bindingPlan) {
  return bindings.map((binding) => {
    const planned = bindingPlan.byName.get(binding.name)
      ?? bindingPlan.bySlot.get(`${binding.set ?? 0}:${binding.binding ?? 0}`);
    if (!planned) return binding;
    return binding.type === 'sampledImage'
      ? { ...binding, binding: planned.binding, samplerBinding: planned.samplerBinding }
      : { ...binding, binding: planned.binding };
  });
}

export function transformSpirvForWebGpu(spirv, bindingPlan) {
  const words = spirv instanceof Uint32Array ? spirv : new Uint32Array(spirv);
  const instructions = parseInstructions(words);
  const module = analyzeSpirv(instructions);
  const sampledVariables = findSampledImageVariables(module);

  let nextId = words[3];
  const samplerTypeId = module.samplerTypeId ?? nextId++;
  const additions = {
    names: [],
    annotations: [],
    types: module.samplerTypeId ? [] : [makeInstruction(OPCODES.OpTypeSampler, [samplerTypeId])],
    variables: []
  };
  const sampledByOriginalVariable = new Map();

  for (const sampled of sampledVariables) {
    const decoration = module.decorations.get(sampled.variableId) ?? {};
    const set = decoration.set ?? 0;
    const binding = decoration.binding ?? 0;
    const planned = bindingPlan.bySlot.get(`${set}:${binding}`) ?? {
      set,
      binding,
      samplerBinding: binding + 1
    };
    const imagePointerTypeId = module.pointerTypesByKey.get(`${STORAGE_CLASS.UniformConstant}:${sampled.imageTypeId}`)
      ?? nextId++;
    const samplerPointerTypeId = module.pointerTypesByKey.get(`${STORAGE_CLASS.UniformConstant}:${samplerTypeId}`)
      ?? nextId++;
    const imageVariableId = nextId++;
    const samplerVariableId = nextId++;

    if (!module.pointerTypesByKey.has(`${STORAGE_CLASS.UniformConstant}:${sampled.imageTypeId}`)) {
      additions.types.push(makeInstruction(OPCODES.OpTypePointer, [
        imagePointerTypeId,
        STORAGE_CLASS.UniformConstant,
        sampled.imageTypeId
      ]));
      module.pointerTypesByKey.set(`${STORAGE_CLASS.UniformConstant}:${sampled.imageTypeId}`, imagePointerTypeId);
    }
    if (!module.pointerTypesByKey.has(`${STORAGE_CLASS.UniformConstant}:${samplerTypeId}`)) {
      additions.types.push(makeInstruction(OPCODES.OpTypePointer, [
        samplerPointerTypeId,
        STORAGE_CLASS.UniformConstant,
        samplerTypeId
      ]));
      module.pointerTypesByKey.set(`${STORAGE_CLASS.UniformConstant}:${samplerTypeId}`, samplerPointerTypeId);
    }

    additions.variables.push(makeInstruction(OPCODES.OpVariable, [
      imagePointerTypeId,
      imageVariableId,
      STORAGE_CLASS.UniformConstant
    ]));
    additions.variables.push(makeInstruction(OPCODES.OpVariable, [
      samplerPointerTypeId,
      samplerVariableId,
      STORAGE_CLASS.UniformConstant
    ]));
    additions.annotations.push(makeInstruction(OPCODES.OpDecorate, [
      imageVariableId,
      DECORATIONS.DescriptorSet,
      planned.set
    ]));
    additions.annotations.push(makeInstruction(OPCODES.OpDecorate, [
      imageVariableId,
      DECORATIONS.Binding,
      planned.binding
    ]));
    additions.annotations.push(makeInstruction(OPCODES.OpDecorate, [
      samplerVariableId,
      DECORATIONS.DescriptorSet,
      planned.set
    ]));
    additions.annotations.push(makeInstruction(OPCODES.OpDecorate, [
      samplerVariableId,
      DECORATIONS.Binding,
      planned.samplerBinding
    ]));

    const baseName = module.names.get(sampled.variableId) ?? `sampled_${sampled.variableId}`;
    additions.names.push(makeNameInstruction(imageVariableId, `${baseName}_texture`));
    additions.names.push(makeNameInstruction(samplerVariableId, `${baseName}_sampler`));

    sampledByOriginalVariable.set(sampled.variableId, {
      ...sampled,
      imageVariableId,
      samplerVariableId,
      imageTypeId: sampled.imageTypeId,
      samplerTypeId
    });
  }

  const output = [];
  let addedNames = additions.names.length === 0;
  let addedAnnotations = additions.annotations.length === 0;
  let addedTypesAndVariables = additions.types.length === 0 && additions.variables.length === 0;
  for (let index = 0; index < instructions.length; index += 1) {
    const instruction = instructions[index];
    if (!addedNames && instruction.opcode !== OPCODES.OpName && hasSeenOpcode(instructions, index, OPCODES.OpName)) {
      output.push(...additions.names);
      addedNames = true;
    }
    if (!addedAnnotations && instruction.opcode !== OPCODES.OpDecorate && hasSeenOpcode(instructions, index, OPCODES.OpDecorate)) {
      output.push(...additions.annotations);
      addedAnnotations = true;
    }
    if (!addedTypesAndVariables && instruction.opcode === OPCODES.OpFunction) {
      output.push(...additions.types);
      output.push(...additions.variables);
      addedTypesAndVariables = true;
    }
    if (instruction.opcode === OPCODES.OpName && sampledByOriginalVariable.has(instruction.operands[0])) {
      continue;
    }
    if (instruction.opcode === OPCODES.OpDecorate && sampledByOriginalVariable.has(instruction.operands[0])) {
      continue;
    }
    if (instruction.opcode === OPCODES.OpDecorate && instruction.operands[1] === DECORATIONS.Binding) {
      const targetId = instruction.operands[0];
      const decoration = module.decorations.get(targetId);
      const planned = decoration
        ? bindingPlan.bySlot.get(`${decoration.set ?? 0}:${decoration.binding ?? 0}`)
        : null;
      if (planned) {
        output.push(makeInstruction(OPCODES.OpDecorate, [
          targetId,
          DECORATIONS.Binding,
          planned.binding
        ]));
        continue;
      }
    }
    if (instruction.opcode === OPCODES.OpVariable && sampledByOriginalVariable.has(instruction.operands[1])) {
      continue;
    }
    if (instruction.opcode === OPCODES.OpLoad && sampledByOriginalVariable.has(instruction.operands[2])) {
      const resultTypeId = instruction.operands[0];
      const resultId = instruction.operands[1];
      const sampled = sampledByOriginalVariable.get(instruction.operands[2]);
      const imageLoadId = nextId++;
      const samplerLoadId = nextId++;
      output.push(makeInstruction(OPCODES.OpLoad, [sampled.imageTypeId, imageLoadId, sampled.imageVariableId]));
      output.push(makeInstruction(OPCODES.OpLoad, [sampled.samplerTypeId, samplerLoadId, sampled.samplerVariableId]));
      output.push(makeInstruction(OPCODES.OpSampledImage, [resultTypeId, resultId, imageLoadId, samplerLoadId]));
      continue;
    }

    output.push(instruction.words);
  }

  const result = new Uint32Array(5 + output.reduce((count, item) => count + item.length, 0));
  result.set(words.slice(0, 5), 0);
  result[3] = nextId;
  let offset = 5;
  for (const item of output) {
    result.set(item, offset);
    offset += item.length;
  }
  return { words: result };
}

function parseInstructions(words) {
  const instructions = [];
  for (let offset = 5; offset < words.length;) {
    const first = words[offset];
    const wordCount = first >>> 16;
    const opcode = first & 0xffff;
    const instructionWords = words.slice(offset, offset + wordCount);
    instructions.push({
      offset,
      opcode,
      operands: Array.from(instructionWords.slice(1)),
      words: instructionWords
    });
    offset += wordCount;
  }
  return instructions;
}

function analyzeSpirv(instructions) {
  const names = new Map();
  const imageTypes = new Map();
  const sampledImageTypes = new Map();
  const pointerTypes = new Map();
  const pointerTypesByKey = new Map();
  const variables = new Map();
  const decorations = new Map();
  let samplerTypeId = null;

  for (const instruction of instructions) {
    const operands = instruction.operands;
    if (instruction.opcode === OPCODES.OpName) {
      names.set(operands[0], decodeSpirvString(operands, 1));
    } else if (instruction.opcode === OPCODES.OpTypeImage) {
      imageTypes.set(operands[0], { sampledTypeId: operands[1] });
    } else if (instruction.opcode === OPCODES.OpTypeSampler) {
      samplerTypeId = operands[0];
    } else if (instruction.opcode === OPCODES.OpTypeSampledImage) {
      sampledImageTypes.set(operands[0], { imageTypeId: operands[1] });
    } else if (instruction.opcode === OPCODES.OpTypePointer) {
      pointerTypes.set(operands[0], { storageClass: operands[1], typeId: operands[2] });
      pointerTypesByKey.set(`${operands[1]}:${operands[2]}`, operands[0]);
    } else if (instruction.opcode === OPCODES.OpVariable) {
      variables.set(operands[1], {
        pointerTypeId: operands[0],
        storageClass: operands[2]
      });
    } else if (instruction.opcode === OPCODES.OpDecorate) {
      const targetId = operands[0];
      const decoration = operands[1];
      const entry = decorations.get(targetId) ?? {};
      if (decoration === DECORATIONS.Binding) entry.binding = operands[2];
      if (decoration === DECORATIONS.DescriptorSet) entry.set = operands[2];
      decorations.set(targetId, entry);
    }
  }

  return {
    names,
    imageTypes,
    sampledImageTypes,
    pointerTypes,
    pointerTypesByKey,
    variables,
    decorations,
    samplerTypeId
  };
}

function findSampledImageVariables(module) {
  const result = [];
  for (const [variableId, variable] of module.variables.entries()) {
    if (variable.storageClass !== STORAGE_CLASS.UniformConstant) continue;
    const pointer = module.pointerTypes.get(variable.pointerTypeId);
    if (!pointer) continue;
    const sampledImage = module.sampledImageTypes.get(pointer.typeId);
    if (!sampledImage) continue;
    result.push({
      variableId,
      sampledImageTypeId: pointer.typeId,
      imageTypeId: sampledImage.imageTypeId
    });
  }
  return result;
}

function makeInstruction(opcode, operands) {
  return new Uint32Array([((operands.length + 1) << 16) | opcode, ...operands]);
}

function makeNameInstruction(targetId, name) {
  return makeInstruction(OPCODES.OpName, [targetId, ...encodeSpirvString(name)]);
}

function hasSeenOpcode(instructions, endIndex, opcode) {
  for (let index = 0; index < endIndex; index += 1) {
    if (instructions[index].opcode === opcode) return true;
  }
  return false;
}

function decodeSpirvString(operands, startIndex) {
  const bytes = [];
  for (let index = startIndex; index < operands.length; index += 1) {
    const word = operands[index];
    for (let shift = 0; shift < 32; shift += 8) {
      const byte = (word >>> shift) & 0xff;
      if (byte === 0) return new TextDecoder().decode(new Uint8Array(bytes));
      bytes.push(byte);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function encodeSpirvString(value) {
  const bytes = [...new TextEncoder().encode(value), 0];
  while (bytes.length % 4 !== 0) bytes.push(0);
  const words = [];
  for (let index = 0; index < bytes.length; index += 4) {
    words.push(
      bytes[index]
        | (bytes[index + 1] << 8)
        | (bytes[index + 2] << 16)
        | (bytes[index + 3] << 24)
    );
  }
  return words;
}

async function runNagaWgsl(words, stage) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'ring-naga-'));
  try {
    const inputPath = path.join(tempDir, 'input.spv');
    const outputPath = path.join(tempDir, 'output.wgsl');
    await writeFile(inputPath, new Uint8Array(words.buffer, words.byteOffset, words.byteLength));
    const nagaResult = await runNagaCli([
      '--input-kind',
      'spv',
      '--shader-stage',
      toNagaStage(stage),
      'input.spv',
      'output.wgsl'
    ], tempDir);
    try {
      return await readFile(outputPath, 'utf8');
    } catch (error) {
      throw new Error(nagaResult.errorMessage || error.message);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function runNagaCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const bin = path.join(path.dirname(require.resolve('naga-wasi-cli/package.json')), 'bin', 'naga.mjs');
    const output = [];
    const child = spawn(process.execPath, [bin, ...args], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout?.on('data', (chunk) => output.push(String(chunk)));
    child.stderr?.on('data', (chunk) => output.push(String(chunk)));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ ok: true });
        return;
      }
      resolve({
        ok: false,
        errorMessage: output.join('').trim() || `naga exited with code ${code}`
      });
    });
  });
}

function toNagaStage(stage) {
  if (stage === 'vertex') return 'vert';
  if (stage === 'fragment') return 'frag';
  if (stage === 'compute') return 'compute';
  return stage;
}
