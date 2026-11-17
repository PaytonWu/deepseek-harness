/**
 * The persisted DingTalk channel configuration: notification group id and the
 * sender whitelist, stored at pi-agent home so the wizard can update it
 * without touching cordis.yml. Persisted values override the cordis config
 * defaults field by field.
 * @module pi-agent-channel-store
 */

import { readFileSync, writeFileSync } from 'node:fs'

/** One persisted channel snapshot. */
export interface ChannelState {
  /** Notification group; persisted value wins over the cordis default. */
  readonly dingtalkGroupId?: string
  /** Whitelisted sender openDingTalkIds; persisted value wins over the cordis default. */
  readonly allowedSenderIds?: readonly string[]
  /** A capture round is waiting for one group message to admit its sender. */
  readonly capturePending?: boolean
}

/** The channel configuration a controller consumes, with capture state split off. */
export interface EffectiveChannel {
  readonly dingtalkGroupId?: string
  readonly allowedSenderIds?: readonly string[]
}

/**
 * Load, mutate, and persist the channel configuration. A malformed file fails
 * loudly (same convention as the employee directory); a missing file starts
 * from the cordis defaults alone.
 */
export class ChannelStore {
  static load(file: string, defaults: { dingtalkGroupId?: string; allowedSenderIds?: readonly string[] }): ChannelStore {
    let persisted: Partial<ChannelState> = {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      if (parsed !== null && typeof parsed === 'object') persisted = parsed
      else throw new Error('channel.json must contain an object')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`pi-agent: channel config ${file} is malformed: ${String(error)}`)
      }
    }
    return new ChannelStore(file, defaults, persisted)
  }

  private constructor(
    private readonly file: string,
    private readonly defaults: { dingtalkGroupId?: string; allowedSenderIds?: readonly string[] },
    private state: Partial<ChannelState>,
  ) {}

  /** The configuration a channel controller should run with right now. */
  effective(): EffectiveChannel {
    return {
      ...(this.state.dingtalkGroupId !== undefined || this.defaults.dingtalkGroupId !== undefined
        ? { dingtalkGroupId: this.state.dingtalkGroupId ?? this.defaults.dingtalkGroupId }
        : {}),
      ...(this.state.allowedSenderIds !== undefined || this.defaults.allowedSenderIds !== undefined
        ? { allowedSenderIds: this.state.allowedSenderIds ?? this.defaults.allowedSenderIds }
        : {}),
    }
  }

  /** Whether a capture round is waiting for one group message. */
  isCapturePending(): boolean { return this.state.capturePending === true }

  /** Begin a capture round; the transport callback routes to it until it settles. */
  startCapture(): void {
    this.state = { ...this.state, capturePending: true }
    this.persist()
  }

  /** Abandon a capture round without touching the whitelist. */
  cancelCapture(): void {
    this.state = { ...this.state, capturePending: false }
    this.persist()
  }

  /**
   * Admit one observed sender: dedupe into the whitelist, end the capture
   * round, and persist. @returns whether the whitelist actually grew.
   */
  admitSender(senderId: string): boolean {
    const current = this.state.allowedSenderIds ?? this.defaults.allowedSenderIds ?? []
    if (current.includes(senderId)) {
      this.state = { ...this.state, capturePending: false }
      this.persist()
      return false
    }
    this.state = { ...this.state, allowedSenderIds: [...current, senderId], capturePending: false }
    this.persist()
    return true
  }

  /** Set the notification group and persist. */
  setGroupId(groupId: string): void {
    this.state = { ...this.state, dingtalkGroupId: groupId }
    this.persist()
  }

  private persist(): void {
    writeFileSync(this.file, `${JSON.stringify(this.state, undefined, 2)}\n`, 'utf8')
  }
}
