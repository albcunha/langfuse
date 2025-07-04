import { checkHasProtectedLabels } from '../utils/checkHasProtectedLabels';
import { logger, PromptService } from '@langfuse/shared/src/server';
import { prisma, Prisma } from '@langfuse/shared/src/db';
import { Prompt } from '@langfuse/shared/src/db';
import { redis } from '@langfuse/shared/src/server';
import {
  InvalidRequestError,
  LangfuseNotFoundError,
  LATEST_PROMPT_LABEL,
} from "@langfuse/shared";

export type DeletePromptParams = {
  promptName: string;
  projectId: string;
  version?: number;
  label?: string;
};

export const deletePrompt = async (params: DeletePromptParams) => {
  const { promptName, projectId, version, label } = params;

  if (version && !label) {
    throw new InvalidRequestError(
      "Cannot specify version without a label for deletion.",
    );
  }

  const promptService = new PromptService(prisma, redis);
  try {
    await promptService.lockCache({ projectId, promptName: promptName });

    const result = await prisma.$transaction(async (tx) => {
      // Full deletion
      if (!version && !label) {
        logger.info(
          `Deleting all versions of prompt ${promptName} in project ${projectId}`,
        );
        const prompts = await tx.prompt.findMany({
          where: { projectId, name: promptName },
        });

        if (prompts.length === 0) {
          throw new LangfuseNotFoundError(`Prompt '${promptName}' not found`);
        }

        const { hasProtectedLabels, protectedLabels } =
          await checkHasProtectedLabels({
            prisma: tx as any,
            projectId,
            labelsToCheck: prompts.flatMap((p) => p.labels),
          });

        if (hasProtectedLabels) {
          throw new InvalidRequestError(
            `Cannot delete prompt because it has protected labels: ${protectedLabels.join(
              ", ",
            )}. Please remove them first or contact an admin.`,
          );
        }

        const dependents = await tx.$queryRaw<any[]>`
          SELECT p."name" AS "parent_name", p."version" AS "parent_version"
          FROM prompt_dependencies pd
          INNER JOIN prompts p ON p.id = pd.parent_id
          WHERE p.project_id = ${projectId}
            AND pd.project_id = ${projectId}
            AND pd.child_name = ${promptName}`;

        if (dependents.length > 0) {
          const dependencyMessages = dependents
            .map(
              (d) =>
                `${d.parent_name} v${d.parent_version} depends on prompt ${promptName}.`,
            )
            .join("\n");
          throw new InvalidRequestError(
            `Other prompts are depending on the prompt you are trying to delete:\n\n${dependencyMessages}\n\nPlease delete the dependent prompts first.`,
          );
        }

        const deletedResult = await tx.prompt.deleteMany({
          where: { id: { in: prompts.map((p) => p.id) } },
        });
        return { promptName, count: deletedResult.count };
      } else {
        // Partial deletion
        let promptsToDelete: Prompt[] = [];
        if (version && label) {
          logger.info(
            `Deleting prompt ${promptName} v${version} with label '${label}' in project ${projectId}`,
          );
          const p = await tx.prompt.findFirst({
            where: {
              projectId,
              name: promptName,
              version,
              labels: { has: label },
            },
          });
          if (p) promptsToDelete.push(p);
        } else if (label) {
          // and !version
          logger.info(
            `Deleting prompts for ${promptName} with label '${label}' in project ${projectId}`,
          );
          promptsToDelete = await tx.prompt.findMany({
            where: { projectId, name: promptName, labels: { has: label } },
          });
        }

        if (promptsToDelete.length === 0) {
          throw new LangfuseNotFoundError(
            `Prompt '${promptName}' with specified version or label not found`,
          );
        }

        const { hasProtectedLabels, protectedLabels } =
          await checkHasProtectedLabels({
            prisma: tx as any,
            projectId,
            labelsToCheck: promptsToDelete.flatMap((p) => p.labels),
          });

        if (hasProtectedLabels) {
          throw new InvalidRequestError(
            `Cannot delete prompt version because it has protected labels: ${protectedLabels.join(
              ", ",
            )}. Please remove them first or contact an admin.`,
          );
        }

        const versionsToDelete = promptsToDelete.map((p) => p.version);
        const labelsToDelete = [
          ...new Set(promptsToDelete.flatMap((p) => p.labels)),
        ];

        const dependents = await tx.$queryRaw<any[]>`
            SELECT
              p."name" AS "parent_name", p."version" AS "parent_version",
              pd."child_version" AS "child_version", pd."child_label" AS "child_label"
            FROM prompt_dependencies pd
            INNER JOIN prompts p ON p.id = pd.parent_id
            WHERE p.project_id = ${projectId}
              AND pd.project_id = ${projectId}
              AND pd.child_name = ${promptName}
              AND (
                (pd."child_version" IS NOT NULL AND pd."child_version" IN (${Prisma.join(
                  versionsToDelete,
                )}))
                OR
                (pd."child_label" IS NOT NULL AND pd."child_label" IN (${Prisma.join(
                  labelsToDelete,
                )}))
              )`;

        if (dependents.length > 0) {
          const dependencyMessages = dependents
            .map(
              (d) =>
                `${d.parent_name} v${d.parent_version} depends on ${promptName} ${
                  d.child_version ? `v${d.child_version}` : d.child_label
                }`,
            )
            .join("\n");
          throw new InvalidRequestError(
            `Other prompts are depending on the prompt version you are trying to delete:\n\n${dependencyMessages}\n\nPlease delete the dependent prompts first.`,
          );
        }

        const idsToDelete = promptsToDelete.map((p) => p.id);
        await tx.prompt.deleteMany({
          where: { id: { in: idsToDelete } },
        });

        const hadLatestLabel = promptsToDelete.some((p) =>
          p.labels.includes(LATEST_PROMPT_LABEL),
        );

        if (hadLatestLabel) {
          const newLatestPrompt = await tx.prompt.findFirst({
            where: {
              projectId,
              name: promptName,
              // Exclude the ones we just deleted
              id: { notIn: idsToDelete },
            },
            orderBy: [{ version: "desc" }],
          });

          if (newLatestPrompt) {
            await tx.prompt.update({
              where: { id: newLatestPrompt.id },
              data: { labels: { push: LATEST_PROMPT_LABEL } },
            });
          }
        }
        return { deletedIds: idsToDelete };
      }
    });

    await promptService.invalidateCache({ projectId, promptName: promptName });
    await promptService.unlockCache({ projectId, promptName: promptName });

    return result;
  } catch (e) {
    await promptService.unlockCache({ projectId, promptName: promptName });

    throw e;
  }
};
