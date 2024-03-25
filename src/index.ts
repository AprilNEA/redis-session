import { Redis } from 'ioredis'
import { nanoid } from 'nanoid'
import { CookieSerializeOptions } from "./cookie";

/**
 * A class for managing user sessions in Redis.
 */
export class RedisSession<TUserId extends string, TPayload extends {}> {
  /**
   * Creates a new RedisSession instance.
   * @param redisClient The Redis client.
   * @param redisKey The Redis key prefix.
   * @param duration The session duration in seconds. Default is 30 days.
   * @param cookieName The name of the cookie to set.
   * @param setCookie A function to set a cookie.
   * @param deleteCookie A function to delete a cookie.
   */
  constructor(
    public redisClient: Redis,
    protected readonly redisKey: { session: string; sessions: string },
    protected readonly duration: number = 30 * 24 * 60 * 60,
    protected cookieName: string = 'sessionId',
    protected setCookie?: (name: string, value: string, options?: CookieSerializeOptions) => void,
    protected deleteCookie?: (name: string, options?: CookieSerializeOptions) => void
  ) {
  }

  /**
   * Deletes a session by ID.
   * @param sessionId The session ID.
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.redisClient.del(this.redisKey.session + sessionId)
    this.deleteCookie?.(this.cookieName)
  }

  /**
   * Deletes all sessions for a user.
   * @param userId The user ID.
   */
  async deleteUserSessions(userId: TUserId): Promise<void> {
    const sessions = await this.redisClient.zrange(this.redisKey.sessions + userId, 0, -1)
    if (sessions.length > 0) {
      const pipeline = this.redisClient.pipeline()
      sessions.forEach(sessionId => {
        pipeline.del(this.redisKey.session + sessionId)
      })
      pipeline.del(this.redisKey.sessions + userId)
      await pipeline.exec()
    }
  }

  /**
   * Deletes all expired sessions.
   */
  async deleteExpiredSessions(): Promise<void> {
    const now = Date.now()
    // Assuming that the score in the sorted set is the expiration timestamp
    const keys = await this.redisClient.keys(this.redisKey.sessions + '*')
    const pipeline = this.redisClient.pipeline()
    keys.forEach(key => {
      pipeline.zremrangebyscore(key, '-inf', now)
    })
    await pipeline.exec()
  }

  /**
   * Gets all sessions for a user.
   * @param userId The user ID.
   */
  async getUserSessions(userId: TUserId) {
    const sessionsWithScores = await this.redisClient.zrange(
      this.redisKey.sessions + userId,
      0,
      -1,
      'WITHSCORES',
    )

    const pipeline = this.redisClient.pipeline()

    // 对于每一个 sessionId，使用 hgetall 命令获取哈希数据
    for (let i = 0; i < sessionsWithScores.length; i += 2) {
      const sessionId = sessionsWithScores[i]
      pipeline.hgetall(this.redisKey.sessions + sessionId)
    }

    return await pipeline.exec()
  }

  /**
   * Sets a new session.
   * @param userId The user ID.
   * @param role The user role.
   * @param payload Additional session data.
   */
  async setSession(
    userId: TUserId,
    role?: string | null,
    payload?: TPayload,
  ): Promise<void> {
    const sessionId = nanoid()
    const now = Date.now()
    const duration = 30 * 24 * 60 * 60 // 时间：一个月 秒
    const expires = now + duration * 1000

    const sessionKey = this.redisKey.session + sessionId
    const sessionsKey = this.redisKey.sessions + userId

    await this.redisClient
      .multi()
      .hset(sessionKey, {
        userId: userId.toString(),
        role: role || undefined,
        ...payload,
      })
      .expire(sessionKey, duration)
      .zremrangebyscore(sessionsKey, '-inf', now)
      .zadd(sessionsKey, expires, sessionId)
      .exec((err, _) => {
        if (err) {
          // throw
        }
      })

    this.setCookie?.(this.cookieName, sessionId, {expires: new Date(expires)})
  }

  /**
   * Gets a session by ID.
   * @param sessionId The session ID.
   */
  async getSession(sessionId: string): Promise<{
    userId: TUserId | null
    role: string | null
  }> {
    const results = await this.redisClient.hmget(
      this.redisKey.session + sessionId,
      'userId',
      'role',
    )
    return {
      userId: results[0] as TUserId | null,
      role: results[1],
    }
  }

  /**
   * Updates the expiration of a session.
   * @param sessionId The session ID.
   */
  async updateSessionExpiration(sessionId: string): Promise<void> {
    const sessionKey = this.redisKey.session + sessionId
    const userId: TUserId | null = await this.redisClient.hget(sessionKey, 'userId') as TUserId | null
    if (userId) {
      const now = Date.now()
      const expires = now + this.duration * 1000
      const sessionsKey = this.redisKey.sessions + userId
      await this.redisClient
        .multi()
        .expire(sessionKey, this.duration)
        .zadd(sessionsKey, expires, sessionId)
        .exec()
    }
  }
}
