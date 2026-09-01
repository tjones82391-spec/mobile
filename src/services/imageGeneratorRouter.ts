/**
 * Image generator router.
 *
 * Single decision point: given an ActiveImageModel, return the generator that
 * should execute the job.  All other code refers to this function instead of
 * importing a concrete generator directly.
 *
 * Routing rules:
 *   activeImageModel.backend === 'fal'  → cloudImageGenerator
 *   everything else                     → localDreamGeneratorService (ONNX / CoreML)
 *
 * The local path is completely unchanged — if the backend field is absent or
 * anything other than 'fal', this router is transparent.
 */

import { localDreamGeneratorService } from './localDreamGenerator';
import { cloudImageGenerator } from './cloudImageGenerator';
import type { ActiveImageModel, ImageGenerator } from './imageGenerationTypes';

export type { ImageGenerator } from './imageGenerationTypes';

/**
 * Return the generator responsible for the given model.
 *
 * @param model  The currently active image model descriptor.
 * @returns      The appropriate generator singleton.
 */
export function getGenerator(model: ActiveImageModel): ImageGenerator {
  if (model.backend === 'fal') {
    return cloudImageGenerator;
  }
  return localDreamGeneratorService;
}
