import { authorizePromptRequestOrThrow } from '../utils/authorizePromptRequest';
import { deletePrompt } from '@/src/features/prompts/server/actions/deletePrompt';
import { getPromptByName } from '@/src/features/prompts/server/actions/getPromptByName';
import { RateLimitService } from '@/src/features/public-api/server/RateLimitService';
import { withMiddlewares } from '@/src/features/public-api/server/withMiddlewares';
import type { NextApiRequest, NextApiResponse } from "next";

import {
  GetPromptByNameSchema,
  LangfuseNotFoundError,
  PRODUCTION_LABEL,
} from "@langfuse/shared";

const getPromptNameHandler = async (
  req: NextApiRequest,
  res: NextApiResponse,
) => {
  const authCheck = await authorizePromptRequestOrThrow(req);

  const rateLimitCheck = await RateLimitService.getInstance().rateLimitRequest(
    authCheck.scope,
    "prompts",
  );

  if (rateLimitCheck?.isRateLimited()) {
    return rateLimitCheck.sendRestResponseIfLimited(res);
  }

  const { promptName, version, label } = GetPromptByNameSchema.parse(req.query);

  const prompt = await getPromptByName({
    promptName: promptName,
    projectId: authCheck.scope.projectId,
    version,
    label,
  });

  if (!prompt) {
    let errorMessage = `Prompt not found: '${promptName}'`;

    if (version) {
      errorMessage += ` with version ${version}`;
    } else {
      errorMessage += ` with label '${label ?? PRODUCTION_LABEL}'`;
    }

    throw new LangfuseNotFoundError(errorMessage);
  }

  return res.status(200).json(prompt);
};


const deletePromptNameHandler = async (
  req: NextApiRequest,
  res: NextApiResponse,
) => {
  const authCheck = await authorizePromptRequestOrThrow(req);

  const rateLimitCheck = await RateLimitService.getInstance().rateLimitRequest(
    authCheck.scope,
    "prompts",
  );

  if (rateLimitCheck?.isRateLimited()) {
    return rateLimitCheck.sendRestResponseIfLimited(res);
  }

  const { version, label } = GetPromptByNameSchema.parse(req.query);
  const promptName = Array.isArray(req.query.promptName)
    ? req.query.promptName.join("/")
    : req.query.promptName;

  if (!promptName) {
    throw new LangfuseNotFoundError("Prompt name not provided.");
  }

  const result = await deletePrompt({
    promptName: promptName,
    projectId: authCheck.scope.projectId,
    version: version ?? undefined,
    label: label ?? undefined,
  });

  let message: string;
  if ("count" in result) {
    message = `Successfully deleted all versions of prompt '${promptName}'`;
  } else {
    message = `Successfully deleted prompt version(s) with ID(s): ${result.deletedIds.join(
      ", ",
    )}.`;
  }

  return res.status(200).json({ message });
};

export const promptNameHandler = withMiddlewares({
  GET: getPromptNameHandler,
  DELETE: deletePromptNameHandler,
});
