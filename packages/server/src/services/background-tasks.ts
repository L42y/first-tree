import type { FastifyInstance } from "fastify";
import { createLogger } from "../observability/index.js";
import { backfillExternalAttachmentsToPostgres, sweepOrphanAttachments } from "./attachment.js";
import * as inboxService from "./chat/inbox.js";
import { createCronScheduler } from "./chat/scheduled-jobs/scheduler.js";
import * as chatArchiveService from "./chat/workspace/archive.js";
import * as clientService from "./client.js";
import * as notificationService from "./notification.js";
import * as presenceService from "./presence.js";
import { backfillSkillResourceBundles } from "./skill-bundle.js";

const log = createLogger("BackgroundTasks");

export type BackgroundTasks = {
  start(): void;
  stop(): Promise<void>;
};

export type BackgroundTaskOptions = {
  cronSchedulerEnabled?: boolean;
};

export function createBackgroundTasks(
  app: FastifyInstance,
  instanceId: string,
  options: BackgroundTaskOptions = {},
): BackgroundTasks {
  let inboxTimer: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let archiveSweepTimer: ReturnType<typeof setInterval> | null = null;
  let attachmentSweepTimer: ReturnType<typeof setInterval> | null = null;
  const cronScheduler = options.cronSchedulerEnabled === false ? null : createCronScheduler(app);

  async function maintainAttachments(): Promise<void> {
    const legacyAttachments = await backfillExternalAttachmentsToPostgres(app.db, app.attachmentBlobStore);
    const legacySkills = await backfillSkillResourceBundles(app.db, app.attachmentBlobStore);
    const sweep = await sweepOrphanAttachments(app.db, app.attachmentBlobStore);
    if (legacyAttachments.migrated > 0 || legacySkills.migrated > 0 || sweep.deleted > 0) {
      log.info({ legacyAttachments, legacySkills, sweep }, "attachment maintenance completed");
    }
  }

  return {
    start() {
      inboxTimer = setInterval(async () => {
        try {
          const pruned = await inboxService.pruneStaleSilentEntries(app.db);
          if (pruned.ackedDeleted > 0 || pruned.stalePendingDeleted > 0) {
            log.debug(
              { ackedDeleted: pruned.ackedDeleted, stalePendingDeleted: pruned.stalePendingDeleted },
              "pruned silent inbox rows",
            );
          }
        } catch (err) {
          log.error({ err }, "failed to prune silent inbox rows");
        }
      }, 60_000);

      heartbeatTimer = setInterval(async () => {
        try {
          await presenceService.heartbeatInstance(app.db, instanceId);
          const staleSeconds = app.config.runtime.presenceCleanupSeconds;
          await presenceService.cleanupStalePresence(app.db, staleSeconds);
          await clientService.cleanupStaleClients(app.db, staleSeconds);
          const staleAgents = await presenceService.markStaleAgents(app.db, staleSeconds);
          if (staleAgents.length > 0) {
            log.info({ count: staleAgents.length, agentIds: staleAgents }, "marked agents as stale");
            for (const agentId of staleAgents) {
              notificationService.notifyAgentEvent(app.db, agentId, "agent_stale", "medium").catch(() => {});
            }
          }
        } catch (err) {
          log.error({ err }, "failed to heartbeat / cleanup presence");
        }
      }, 30_000);

      const archiveSweepSeconds = app.config.runtime.archiveSweepIntervalSeconds;
      if (archiveSweepSeconds > 0) {
        archiveSweepTimer = setInterval(async () => {
          try {
            const stats = await chatArchiveService.sweepChatArchive(app.db, {
              mappedIdleSeconds: app.config.runtime.archiveMappedIdleSeconds,
            });
            if (stats.mappedRowsArchived > 0 || stats.unmappedRowsArchived > 0) {
              log.info(stats, "chat auto-archive sweep flipped rows to archived");
            }
          } catch (err) {
            log.error({ err }, "chat auto-archive sweep failed");
          }
        }, archiveSweepSeconds * 1000);
      }

      attachmentSweepTimer = setInterval(
        async () => {
          try {
            await maintainAttachments();
          } catch (err) {
            log.error({ err }, "attachment maintenance failed");
          }
        },
        60 * 60 * 1000,
      );

      cronScheduler?.start();

      presenceService.heartbeatInstance(app.db, instanceId).catch((err) => {
        log.error({ err }, "failed initial heartbeat");
      });
      sweepOrphanAttachments(app.db, app.attachmentBlobStore).catch((err) => {
        log.error({ err }, "initial orphan attachment sweep failed");
      });
    },

    async stop() {
      await cronScheduler?.stop();
      if (inboxTimer) {
        clearInterval(inboxTimer);
        inboxTimer = null;
      }
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (archiveSweepTimer) {
        clearInterval(archiveSweepTimer);
        archiveSweepTimer = null;
      }
      if (attachmentSweepTimer) {
        clearInterval(attachmentSweepTimer);
        attachmentSweepTimer = null;
      }
    },
  };
}
