/**
 * LocalDynamoClientAdapter — routes DynamoDB-style send() calls through KeyValueStore.
 */
import type { KeyValueStore, CompositeKey, QueryOptions } from '@swarm/core';
import type { LocalAdapterResult } from './adapter-base.js';

export class LocalDynamoClientAdapter {
  constructor(private store: KeyValueStore) {}

  async send(command: unknown): Promise<LocalAdapterResult> {
    const cmd = command as { input: Record<string, unknown>; constructor?: { name?: string } };
    const name = cmd.constructor?.name ?? '';
    const input = cmd.input;

    // Match by name prefix — handles Bun-compiled name mangling (PutCommand3, etc.)
    if (name.startsWith('GetCommand')) return this._get(input);
    if (name.startsWith('PutCommand')) return this._put(input);
    if (name.startsWith('QueryCommand')) return this._query(input);
    if (name.startsWith('DeleteCommand')) return this._del(input);
    if (name.startsWith('UpdateCommand')) return this._update(input);
    if (name.startsWith('ScanCommand')) return this._scan(input);
    if (name.startsWith('BatchWriteCommand')) return this._batchWrite(input);
    if (name.startsWith('TransactWrite')) return this._transactWrite(input);

    throw new Error(`LocalDynamoClientAdapter: unsupported command "${name}"`);
  }

  private tableName(input: Record<string, unknown>): string {
    return String(input.TableName ?? 'default');
  }

  private tablePrefix(tableName: string): string {
    return `TABLE#${encodeURIComponent(tableName)}#`;
  }

  private toStoredKey(tableName: string, key: CompositeKey): CompositeKey {
    return {
      pk: `${this.tablePrefix(tableName)}${key.pk}`,
      sk: key.sk,
    };
  }

  private toStoredItem<T extends Record<string, unknown> & CompositeKey>(
    tableName: string,
    item: T,
  ): T {
    return {
      ...item,
      pk: `${this.tablePrefix(tableName)}${item.pk}`,
    };
  }

  private fromStoredItem<T extends Record<string, unknown>>(
    tableName: string,
    item: T | null | undefined,
  ): T | null {
    if (!item) return null;
    const prefix = this.tablePrefix(tableName);
    const pk = typeof item.pk === 'string' && item.pk.startsWith(prefix)
      ? item.pk.slice(prefix.length)
      : item.pk;
    return this.normalizeLegacyItem(tableName, { ...item, pk } as T);
  }

  private isAdminTable(tableName: string): boolean {
    return tableName === process.env.ADMIN_TABLE || /admin/i.test(tableName);
  }

  private normalizeLegacyItem<T extends Record<string, unknown>>(tableName: string, item: T): T {
    if (!this.isAdminTable(tableName)) return item;
    if (typeof item.pk !== 'string' || !item.pk.startsWith('AVATAR#') || item.sk !== 'CONFIG') return item;
    if (!item.config || typeof item.config !== 'object' || item.avatarId) return item;

    const config = item.config as Record<string, unknown>;
    const llm = (config.llm && typeof config.llm === 'object')
      ? config.llm as Record<string, unknown>
      : {};
    const voice = (config.voice && typeof config.voice === 'object')
      ? config.voice as Record<string, unknown>
      : {};
    const media = (config.media && typeof config.media === 'object')
      ? config.media as Record<string, unknown>
      : {};
    const image = (media.image && typeof media.image === 'object')
      ? media.image as Record<string, unknown>
      : undefined;
    const video = (media.video && typeof media.video === 'object')
      ? media.video as Record<string, unknown>
      : undefined;
    const now = typeof item.syncedAt === 'number' ? item.syncedAt : Date.now();
    const id = typeof config.id === 'string' ? config.id : item.pk.slice('AVATAR#'.length);

    return {
      pk: item.pk,
      sk: item.sk,
      avatarId: id,
      name: typeof config.name === 'string' ? config.name : id,
      persona: typeof config.persona === 'string' ? config.persona : undefined,
      systemPromptOverride: config.systemPromptOverride,
      profileImage: config.profileImage,
      characterReference: config.characterReference,
      platforms: (config.platforms && typeof config.platforms === 'object') ? config.platforms : {},
      llmConfig: {
        provider: typeof llm.provider === 'string' ? llm.provider : 'openrouter',
        model: typeof llm.model === 'string' ? llm.model : '',
        fastModel: typeof llm.fastModel === 'string' ? llm.fastModel : undefined,
        thinkingModel: typeof llm.thinkingModel === 'string' ? llm.thinkingModel : undefined,
        temperature: typeof llm.temperature === 'number' ? llm.temperature : 0.8,
        maxTokens: typeof llm.maxTokens === 'number' ? llm.maxTokens : 1024,
        useGlobalKey: true,
      },
      mediaConfig: image ? {
        image: {
          provider: typeof image.provider === 'string' ? image.provider : 'openrouter',
          model: typeof image.model === 'string' ? image.model : '',
        },
        ...(video ? {
          video: {
            provider: typeof video.provider === 'string' ? video.provider : 'openrouter',
            model: typeof video.model === 'string' ? video.model : '',
          },
        } : {}),
        useProfileAsReference: true,
      } : undefined,
      voiceConfig: {
        enabled: typeof voice.enabled === 'boolean' ? voice.enabled : true,
        ttsProvider: typeof voice.ttsProvider === 'string' ? voice.ttsProvider : 'voice-clone',
        format: typeof voice.format === 'string' ? voice.format : 'ogg',
      },
      status: typeof item.status === 'string' ? item.status : 'draft',
      createdAt: now,
      createdBy: 'local@swarm.dev',
      updatedAt: now,
      updatedBy: 'local@swarm.dev',
    } as unknown as T;
  }

  private fromStoredItems<T extends Record<string, unknown>>(
    tableName: string,
    items: T[] | undefined,
  ): T[] {
    return (items ?? []).map((item) => this.fromStoredItem(tableName, item) as T);
  }

  private fromStoredLastEvaluatedKey(
    tableName: string,
    key: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!key) return undefined;
    return this.fromStoredItem(tableName, key) ?? undefined;
  }

  private toStoredLastEvaluatedKey(
    tableName: string,
    key: Record<string, unknown> | undefined,
  ): Record<string, unknown> | undefined {
    if (!key) return undefined;
    const pk = typeof key.pk === 'string' ? `${this.tablePrefix(tableName)}${key.pk}` : key.pk;
    return { ...key, pk };
  }

  private async _get(input: Record<string, unknown>) {
    const tableName = this.tableName(input);
    const key = this.toStoredKey(tableName, input.Key as CompositeKey);
    const item = await this.store.get<Record<string, unknown>>(key, {
      projectionExpression: input.ProjectionExpression as string | undefined,
      expressionAttributeNames: input.ExpressionAttributeNames as Record<string, string> | undefined,
    });
    if (item) {
      return { Item: this.fromStoredItem(tableName, item) ?? undefined, $metadata: { httpStatusCode: 200 } };
    }

    // Backward compatibility for local DBs written before the adapter namespaced
    // logical DynamoDB tables. Once the item is updated it will be written under
    // the table-prefixed key and this fallback stops being used.
    const legacyItem = await this.store.get<Record<string, unknown>>(input.Key as CompositeKey, {
      projectionExpression: input.ProjectionExpression as string | undefined,
      expressionAttributeNames: input.ExpressionAttributeNames as Record<string, string> | undefined,
    });
    return { Item: this.fromStoredItem(tableName, legacyItem) ?? undefined, $metadata: { httpStatusCode: 200 } };
  }

  private async _put(input: Record<string, unknown>) {
    const tableName = this.tableName(input);
    const item = this.toStoredItem(tableName, input.Item as Record<string, unknown> & CompositeKey);
    const { pk, sk, ...rest } = item;
    const hasCond = input.ConditionExpression || input.ExpressionAttributeNames;
    let oldItem: Record<string, unknown> | null = null;
    const rv = input.ReturnValues as string | undefined;
    if (rv === 'ALL_OLD' || rv === 'UPDATED_OLD') {
      oldItem = await this.store.get<Record<string, unknown>>({ pk, sk });
    }
    await this.store.put({ pk, sk, ...rest }, hasCond ? {
      conditionExpression: input.ConditionExpression as string | undefined,
      expressionAttributeNames: input.ExpressionAttributeNames as Record<string, string> | undefined,
      expressionAttributeValues: input.ExpressionAttributeValues as Record<string, unknown> | undefined,
    } : undefined);
    let newItem: Record<string, unknown> | null = null;
    if (rv === 'ALL_NEW' || rv === 'UPDATED_NEW') {
      newItem = await this.store.get<Record<string, unknown>>({ pk, sk });
    }
    const resp: Record<string, unknown> = { $metadata: { httpStatusCode: 200 } };
    if (rv === 'ALL_OLD' || rv === 'UPDATED_OLD') resp.Attributes = this.fromStoredItem(tableName, oldItem) ?? undefined;
    else if (rv === 'ALL_NEW' || rv === 'UPDATED_NEW') resp.Attributes = this.fromStoredItem(tableName, newItem) ?? undefined;
    return resp;
  }

  private async _query(input: Record<string, unknown>) {
    const tableName = this.tableName(input);
    const expr = input.KeyConditionExpression as string;
    const vals = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;

    // Parse KeyConditionExpression — handles pk/sk in any order,
    // with = or begins_with on either key.
    let pk: string | undefined;
    let skCondition: { type: 'begins_with' | 'eq'; value: string } | undefined;

    const eqMatches = expr.match(/(\w+)\s*=\s*(:\w+)/g);
    const beginMatches = expr.match(/begins_with\(\s*(\w+)\s*,\s*(:\w+)\s*\)/g);

    for (const m of (eqMatches || [])) {
      const parts = m.match(/(\w+)\s*=\s*(:\w+)/);
      if (!parts) continue;
      if (parts[1] === 'pk') pk = vals[parts[2]] as string;
      else skCondition = { type: 'eq', value: vals[parts[2]] as string };
    }

    let pkPrefix: string | undefined;
    for (const m of (beginMatches || [])) {
      const parts = m.match(/begins_with\(\s*(\w+)\s*,\s*(:\w+)\s*\)/);
      if (!parts) continue;
      if (parts[1] === 'pk') { pkPrefix = vals[parts[2]] as string; pk = pkPrefix; }
      else skCondition = { type: 'begins_with', value: vals[parts[2]] as string };
    }

    if (!pk) throw new Error(`Unsupported KeyConditionExpression: "${expr}"`);

    // Strip pk/sk values already consumed from the filter values map
    // to avoid SQL parameter count mismatches.
    const consumedKeys = new Set<string>();
    for (const m of (eqMatches || [])) {
      const parts = m.match(/(\w+)\s*=\s*(:\w+)/);
      if (parts) consumedKeys.add(parts[2]);
    }
    for (const m of (beginMatches || [])) {
      const parts = m.match(/begins_with\(\s*(\w+)\s*,\s*(:\w+)\s*\)/);
      if (parts) consumedKeys.add(parts[2]);
    }
    const filterVals: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(vals)) {
      if (!consumedKeys.has(k)) filterVals[k] = v;
    }

    const result = await this.store.queryPage<Record<string, unknown>>(
      `${this.tablePrefix(tableName)}${pk}`,
      {
      skCondition, limit: input.Limit as number | undefined,
      scanForward: input.ScanIndexForward as boolean | undefined,
      filterExpression: input.FilterExpression as string | undefined,
      expressionAttributeNames: input.ExpressionAttributeNames as Record<string, string> | undefined,
      expressionAttributeValues: filterVals,
      projectionExpression: input.ProjectionExpression as string | undefined,
      indexName: input.IndexName as string | undefined,
      pkPrefix: pkPrefix ? `${this.tablePrefix(tableName)}${pkPrefix}` : undefined,
    } as QueryOptions & { pkPrefix?: string },
      this.toStoredLastEvaluatedKey(tableName, input.ExclusiveStartKey as Record<string, unknown> | undefined),
    );

    let items = this.fromStoredItems(tableName, result.items);
    let lastEvaluatedKey = this.fromStoredLastEvaluatedKey(tableName, result.lastEvaluatedKey);

    if (!input.ExclusiveStartKey) {
      const legacyResult = await this.store.queryPage<Record<string, unknown>>(pk, {
        skCondition,
        limit: input.Limit as number | undefined,
        scanForward: input.ScanIndexForward as boolean | undefined,
        filterExpression: input.FilterExpression as string | undefined,
        expressionAttributeNames: input.ExpressionAttributeNames as Record<string, string> | undefined,
        expressionAttributeValues: filterVals,
        projectionExpression: input.ProjectionExpression as string | undefined,
        indexName: input.IndexName as string | undefined,
        pkPrefix,
      } as QueryOptions & { pkPrefix?: string });
      const deduped = new Map<string, Record<string, unknown>>();
      for (const item of this.fromStoredItems(tableName, legacyResult.items)) {
        deduped.set(`${item.pk}\u0000${item.sk}`, item);
      }
      for (const item of items) {
        // Prefer table-prefixed writes over legacy unprefixed rows.
        deduped.set(`${item.pk}\u0000${item.sk}`, item);
      }
      items = Array.from(deduped.values());
      lastEvaluatedKey = lastEvaluatedKey ?? this.fromStoredLastEvaluatedKey(tableName, legacyResult.lastEvaluatedKey);
    }

    return {
      Items: items,
      LastEvaluatedKey: lastEvaluatedKey,
      Count: items.length,
      $metadata: { httpStatusCode: 200 },
    };
  }

  private async _del(input: Record<string, unknown>) {
    const key = this.toStoredKey(this.tableName(input), input.Key as CompositeKey);
    await this.store.delete(key);
    return { $metadata: { httpStatusCode: 200 } };
  }

  private async _update(input: Record<string, unknown>) {
    const tableName = this.tableName(input);
    const key = this.toStoredKey(tableName, input.Key as CompositeKey);
    const result = await this.store.update<Record<string, unknown>>(key, {
      updateExpression: input.UpdateExpression as string,
      conditionExpression: input.ConditionExpression as string | undefined,
      expressionAttributeNames: input.ExpressionAttributeNames as Record<string, string> | undefined,
      expressionAttributeValues: input.ExpressionAttributeValues as Record<string, unknown> | undefined,
      returnValues: (input.ReturnValues as 'ALL_NEW' | 'ALL_OLD' | 'UPDATED_NEW' | 'UPDATED_OLD' | 'NONE' | undefined) ?? 'NONE',
    });
    return { Attributes: this.fromStoredItem(tableName, result) ?? undefined, $metadata: { httpStatusCode: 200 } };
  }

  private async _scan(input: Record<string, unknown>) {
    const tableName = this.tableName(input);
    const prefix = this.tablePrefix(tableName);
    const items = await this.store.scan<Record<string, unknown>>({
      filterExpression: (input.FilterExpression as string) ?? '',
      expressionAttributeValues: (input.ExpressionAttributeValues as Record<string, unknown>) ?? {},
      expressionAttributeNames: input.ExpressionAttributeNames as Record<string, string> | undefined,
      projectionExpression: input.ProjectionExpression as string | undefined,
      limit: input.Limit as number | undefined,
    });
    const tableItems = this.fromStoredItems(
      tableName,
      items.filter((item) => typeof item.pk === 'string' && item.pk.startsWith(prefix)),
    );
    return { Items: tableItems, Count: tableItems.length, $metadata: { httpStatusCode: 200 } };
  }

  private async _batchWrite(input: Record<string, unknown>) {
    const tableName = this.tableName(input);
    const reqItems = input.RequestItems as Record<string, Array<{ PutRequest?: { Item: Record<string, unknown> }; DeleteRequest?: { Key: CompositeKey } }>>;
    const ops: Array<{ type: 'put'; item: Record<string, unknown> & CompositeKey } | { type: 'delete'; key: CompositeKey }> = [];
    for (const [requestTableName, requests] of Object.entries(reqItems)) {
      const operationTableName = requestTableName || tableName;
      for (const req of requests) {
        if (req.PutRequest) {
          ops.push({ type: 'put', item: this.toStoredItem(operationTableName, req.PutRequest.Item as Record<string, unknown> & CompositeKey) });
        } else if (req.DeleteRequest) {
          ops.push({ type: 'delete', key: this.toStoredKey(operationTableName, req.DeleteRequest.Key) });
        }
      }
    }
    for (let i = 0; i < ops.length; i += 25) await this.store.batchWrite(ops.slice(i, i + 25));
    return { $metadata: { httpStatusCode: 200 } };
  }

  private async _transactWrite(input: Record<string, unknown>) {
    const items = input.TransactItems as Array<Record<string, unknown>>;
    // Phase 1: validate and collect all operations, check conditions first
    for (const item of items) {
      if (item.ConditionCheck) {
        const cc = item.ConditionCheck as Record<string, unknown>;
        const tableName = String(cc.TableName ?? this.tableName(input));
        const expr = (cc.ConditionExpression as string) || '';
        const key = this.toStoredKey(tableName, cc.Key as CompositeKey);
        const existing = await this.store.get(key);
        if (expr.includes('attribute_not_exists')) {
          if (existing) throw new Error('TransactionCanceledException');
        } else if (expr.includes('attribute_exists')) {
          if (!existing) throw new Error('TransactionCanceledException');
        } else if (expr.includes('=') || expr.includes('<>') || expr.includes('<') || expr.includes('>') || expr.includes('BETWEEN') || expr.includes('BEGINS_WITH') || expr.includes(' IN ')) {
          // Supported: comparison, BETWEEN, BEGINS_WITH, IN — these pass through in local mode.
          // For full fidelity these would need expression evaluation, but for local dev this is acceptable.
        } else if (expr.trim()) {
          throw new Error(`TransactionCanceledException: unsupported ConditionExpression in local mode: "${expr.slice(0, 80)}"`);
        }
      }
    }

    // Phase 2: execute all writes (local mode best-effort, not true ACID)
    const ops: Array<{ type: 'put'; item: Record<string, unknown> & CompositeKey } | { type: 'delete'; key: CompositeKey }> = [];
    for (const item of items) {
      if (item.Put) {
        const put = item.Put as Record<string, unknown>;
        ops.push({ type: 'put', item: this.toStoredItem(String(put.TableName ?? this.tableName(input)), put.Item as Record<string, unknown> & CompositeKey) });
      } else if (item.Delete) {
        const del = item.Delete as Record<string, unknown>;
        ops.push({ type: 'delete', key: this.toStoredKey(String(del.TableName ?? this.tableName(input)), del.Key as CompositeKey) });
      } else if (item.Update) {
        const u = item.Update as Record<string, unknown>;
        await this.store.update(this.toStoredKey(String(u.TableName ?? this.tableName(input)), u.Key as CompositeKey), {
          updateExpression: u.UpdateExpression as string,
          conditionExpression: u.ConditionExpression as string | undefined,
          expressionAttributeNames: u.ExpressionAttributeNames as Record<string, string> | undefined,
          expressionAttributeValues: u.ExpressionAttributeValues as Record<string, unknown> | undefined,
          returnValues: 'NONE',
        });
      }
    }
    if (ops.length > 0) {
      for (let i = 0; i < ops.length; i += 25) {
        await this.store.batchWrite(ops.slice(i, i + 25));
      }
    }
    return { $metadata: { httpStatusCode: 200 } };
  }
}
