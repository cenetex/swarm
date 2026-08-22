/**
 * Property Research Service
 *
 * Manages property research jobs using web search to gather data.
 * No external API keys required - uses web search to find public information.
 */
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
  DeleteCommand,
} from '@swarm/core';
import { randomUUID } from 'crypto';
import type {
  PropertyAddress,
  PropertyResearchJob,
  PropertyResearchAuth,
  PropertyResearchStatus,
  ResearchProgress,
  PropertyFindings,
  PropertyListing,
  ComparableSale,
  NeighborhoodInfo,
  SchoolInfo,
  AssessorInfo,
} from '../types.js';
import { getDynamoClient } from './dynamo-client.js';
import { createSystemLogger } from './structured-logger.js';

const log = createSystemLogger('property-research');

/**
 * Dependencies interface for property research service (for testing)
 */
export interface PropertyResearchDeps {
  dynamoClient: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: (command: any) => Promise<any>;
  };
  tableName: string;
  generateId: () => string;
}

const TABLE_NAME = process.env.ADMIN_TABLE || 'SwarmAdminTable';

// Default dependencies
const defaultDeps: PropertyResearchDeps = {
  dynamoClient: getDynamoClient(),
  tableName: TABLE_NAME,
  generateId: randomUUID,
};

// TTL durations
const JOB_TTL_DAYS = 7;
const AUTH_TTL_HOURS = 24;

// =============================================================================
// Authorization Management
// =============================================================================

/**
 * Check if a user has authorization to use property research
 */
export async function checkAuth(
  avatarId: string,
  walletAddress: string,
  deps: PropertyResearchDeps = defaultDeps
): Promise<boolean> {
  if (!walletAddress) return false;

  const result = await deps.dynamoClient.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: {
        pk: `PROPERTY_AUTH#${avatarId}`,
        sk: `USER#${walletAddress}`,
      },
    })
  ) as { Item?: PropertyResearchAuth };

  if (!result.Item) return false;

  return result.Item.expiresAt > Date.now();
}

/**
 * Grant property research authorization to a user
 */
export async function grantAuth(
  avatarId: string,
  walletAddress: string,
  deps: PropertyResearchDeps = defaultDeps
): Promise<PropertyResearchAuth> {
  const now = Date.now();
  const expiresAt = now + AUTH_TTL_HOURS * 60 * 60 * 1000;
  const ttl = Math.floor(expiresAt / 1000);

  const auth: PropertyResearchAuth = {
    pk: `PROPERTY_AUTH#${avatarId}`,
    sk: `USER#${walletAddress}`,
    avatarId,
    walletAddress,
    grantedAt: now,
    expiresAt,
    ttl,
  };

  await deps.dynamoClient.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: auth,
    })
  );

  log.info('auth', 'auth_granted', {
    avatarId,
    walletPrefix: walletAddress.slice(0, 8),
  });
  return auth;
}

/**
 * Revoke property research authorization
 */
export async function revokeAuth(
  avatarId: string,
  walletAddress: string,
  deps: PropertyResearchDeps = defaultDeps
): Promise<void> {
  await deps.dynamoClient.send(
    new DeleteCommand({
      TableName: deps.tableName,
      Key: {
        pk: `PROPERTY_AUTH#${avatarId}`,
        sk: `USER#${walletAddress}`,
      },
    })
  );

  log.info('auth', 'auth_revoked', {
    avatarId,
    walletPrefix: walletAddress.slice(0, 8),
  });
}

// =============================================================================
// Job Management
// =============================================================================

/**
 * Create initial research progress
 */
function createInitialProgress(): ResearchProgress {
  return {
    listings: 'pending',
    assessor: 'pending',
    comparables: 'pending',
    demographics: 'pending',
    schools: 'pending',
    walkability: 'pending',
  };
}

/**
 * Create a new property research job
 */
export async function createJob(
  avatarId: string,
  property: PropertyAddress,
  requestedBy?: string,
  deps: PropertyResearchDeps = defaultDeps
): Promise<PropertyResearchJob> {
  const jobId = deps.generateId();
  const now = Date.now();
  const ttl = Math.floor((now + JOB_TTL_DAYS * 24 * 60 * 60 * 1000) / 1000);

  const job: PropertyResearchJob = {
    pk: `PROPERTY_RESEARCH#${jobId}`,
    sk: 'JOB',
    jobId,
    avatarId,
    requestedBy,
    property,
    status: 'queued',
    progress: createInitialProgress(),
    createdAt: now,
    updatedAt: now,
    ttl,
    gsi2pk: `AVATAR#${avatarId}`,
    gsi2sk: `queued#${now}`,
  };

  await deps.dynamoClient.send(
    new PutCommand({
      TableName: deps.tableName,
      Item: job,
    })
  );

  log.info('job', 'job_created', {
    jobId,
    address: property.address,
    city: property.city,
  });
  return job;
}

/**
 * Get a job by ID
 */
export async function getJob(
  jobId: string,
  deps: PropertyResearchDeps = defaultDeps
): Promise<PropertyResearchJob | null> {
  const result = await deps.dynamoClient.send(
    new GetCommand({
      TableName: deps.tableName,
      Key: {
        pk: `PROPERTY_RESEARCH#${jobId}`,
        sk: 'JOB',
      },
    })
  ) as { Item?: PropertyResearchJob };

  return result.Item || null;
}

/**
 * Update job status
 */
export async function updateJobStatus(
  jobId: string,
  status: PropertyResearchStatus,
  updates?: Partial<Pick<PropertyResearchJob, 'progress' | 'findings' | 'reportMarkdown' | 'error'>>,
  deps: PropertyResearchDeps = defaultDeps
): Promise<void> {
  const now = Date.now();
  const job = await getJob(jobId, deps);
  if (!job) return;

  const updateExpressions: string[] = [
    '#status = :status',
    'updatedAt = :now',
    'gsi2sk = :gsi2sk',
  ];
  const expressionValues: Record<string, unknown> = {
    ':status': status,
    ':now': now,
    ':gsi2sk': `${status}#${job.createdAt}`,
  };

  if (updates?.progress) {
    updateExpressions.push('progress = :progress');
    expressionValues[':progress'] = updates.progress;
  }

  if (updates?.findings) {
    updateExpressions.push('findings = :findings');
    expressionValues[':findings'] = updates.findings;
  }

  if (updates?.reportMarkdown) {
    updateExpressions.push('reportMarkdown = :report');
    expressionValues[':report'] = updates.reportMarkdown;
  }

  if (updates?.error) {
    updateExpressions.push('#error = :error');
    expressionValues[':error'] = updates.error;
  }

  if (status === 'completed' || status === 'failed') {
    updateExpressions.push('completedAt = :completedAt');
    expressionValues[':completedAt'] = now;
  }

  await deps.dynamoClient.send(
    new UpdateCommand({
      TableName: deps.tableName,
      Key: {
        pk: `PROPERTY_RESEARCH#${jobId}`,
        sk: 'JOB',
      },
      UpdateExpression: `SET ${updateExpressions.join(', ')}`,
      ExpressionAttributeNames: {
        '#status': 'status',
        '#error': 'error',
      },
      ExpressionAttributeValues: expressionValues,
    })
  );
}

/**
 * Get all jobs for an avatar
 * Uses scan with filter since jobs have TTL (bounded scan)
 */
export async function getJobsForAvatar(
  avatarId: string,
  statusFilter?: PropertyResearchStatus,
  deps: PropertyResearchDeps = defaultDeps
): Promise<PropertyResearchJob[]> {
  // Build filter expression
  let filterExpression = 'begins_with(pk, :jobPrefix) AND avatarId = :avatarId';
  const expressionValues: Record<string, unknown> = {
    ':jobPrefix': 'PROPERTY_RESEARCH#',
    ':avatarId': avatarId,
  };

  if (statusFilter) {
    filterExpression += ' AND #status = :status';
    expressionValues[':status'] = statusFilter;
  }

  const result = await deps.dynamoClient.send(
    new ScanCommand({
      TableName: deps.tableName,
      FilterExpression: filterExpression,
      ExpressionAttributeNames: statusFilter ? { '#status': 'status' } : undefined,
      ExpressionAttributeValues: expressionValues,
      Limit: 50,
    })
  ) as { Items?: PropertyResearchJob[] };

  // Sort by createdAt descending (most recent first)
  const jobs: PropertyResearchJob[] = result.Items || [];
  return jobs.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Delete a job
 */
export async function deleteJob(
  jobId: string,
  deps: PropertyResearchDeps = defaultDeps
): Promise<void> {
  await deps.dynamoClient.send(
    new DeleteCommand({
      TableName: deps.tableName,
      Key: {
        pk: `PROPERTY_RESEARCH#${jobId}`,
        sk: 'JOB',
      },
    })
  );

  log.info('job', 'job_deleted', { jobId });
}

// =============================================================================
// Web Search-Based Research
// =============================================================================

/**
 * Web search function type (injected from MCP adapter)
 */
export type WebSearchFn = (query: string) => Promise<string>;

/**
 * Parse price from string like "$500,000" or "500000"
 */
function parsePrice(priceStr: string | undefined): number | undefined {
  if (!priceStr) return undefined;
  const cleaned = priceStr.replace(/[$,]/g, '');
  const num = parseInt(cleaned, 10);
  return isNaN(num) ? undefined : num;
}

/**
 * Parse number from string
 */
function parseNum(str: string | undefined): number | undefined {
  if (!str) return undefined;
  const num = parseFloat(str);
  return isNaN(num) ? undefined : num;
}

/**
 * Search for property listings
 */
export async function searchListings(
  property: PropertyAddress,
  webSearch: WebSearchFn
): Promise<{ listings: PropertyListing[]; queries: string[] }> {
  const { address, city, state, zip } = property;
  const queries = [
    `"${address}" "${city}" ${state} zillow listing`,
    `"${address}" ${city} ${state} redfin property`,
    `"${address}" ${zip} for sale realtor.com`,
  ];

  const listings: PropertyListing[] = [];
  const searchQueries: string[] = [];

  for (const query of queries) {
    try {
      searchQueries.push(query);
      const results = await webSearch(query);

      // Parse search results for listing information
      // The web search returns markdown-formatted results
      const lines = results.split('\n');

      for (const line of lines) {
        // Look for URLs from listing sites
        const urlMatch = line.match(/https?:\/\/(?:www\.)?(zillow|redfin|realtor)\.com[^\s)]+/i);
        if (urlMatch) {
          const url = urlMatch[0];
          const source = urlMatch[1].toLowerCase();

          // Try to extract price from nearby text
          const priceMatch = line.match(/\$[\d,]+(?:,\d{3})*(?:\.\d{2})?/);
          const bedsMatch = line.match(/(\d+)\s*(?:bed|br|bedroom)/i);
          const bathsMatch = line.match(/(\d+(?:\.\d)?)\s*(?:bath|ba|bathroom)/i);
          const sqftMatch = line.match(/([\d,]+)\s*(?:sq\s*ft|sqft|square\s*feet)/i);

          // Avoid duplicates
          if (!listings.find(l => l.url === url)) {
            listings.push({
              source,
              url,
              priceStr: priceMatch?.[0],
              price: parsePrice(priceMatch?.[0]),
              beds: parseNum(bedsMatch?.[1]),
              baths: parseNum(bathsMatch?.[1]),
              sqft: parseNum(sqftMatch?.[1]?.replace(',', '')),
            });
          }
        }
      }
    } catch (error) {
      log.error('search', 'listings_search_error', {
        query,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { listings, queries: searchQueries };
}

/**
 * Search for comparable sales
 */
export async function searchComparables(
  property: PropertyAddress,
  webSearch: WebSearchFn
): Promise<{ comparables: ComparableSale[]; queries: string[] }> {
  const { city, state, zip } = property;
  const queries = [
    `recent home sales ${city} ${state} ${zip}`,
    `sold homes near ${property.address} ${city} zillow`,
    `comparable sales ${zip} real estate`,
  ];

  const comparables: ComparableSale[] = [];
  const searchQueries: string[] = [];

  for (const query of queries) {
    try {
      searchQueries.push(query);
      const results = await webSearch(query);

      // Parse for sold properties
      const soldMatches = results.matchAll(
        /sold[:\s]+\$?([\d,]+)[^\n]*?(\d+)\s*bed[^\n]*?(\d+(?:\.\d)?)\s*bath[^\n]*?([\d,]+)\s*sq/gi
      );

      for (const match of soldMatches) {
        comparables.push({
          address: 'Nearby property',
          salePrice: parsePrice(match[1]) || 0,
          saleDate: 'Recent',
          beds: parseNum(match[2]),
          baths: parseNum(match[3]),
          sqft: parseNum(match[4]?.replace(',', '')),
          source: 'web search',
        });
      }
    } catch (error) {
      log.error('search', 'comps_search_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { comparables: comparables.slice(0, 10), queries: searchQueries };
}

/**
 * Search for neighborhood/demographic info
 */
export async function searchNeighborhood(
  property: PropertyAddress,
  webSearch: WebSearchFn
): Promise<{ neighborhood: NeighborhoodInfo; queries: string[] }> {
  const { city, state, zip } = property;
  const queries = [
    `${city} ${state} median home price 2024`,
    `${zip} demographics population income`,
    `${city} ${state} crime rate safety`,
  ];

  const neighborhood: NeighborhoodInfo = {
    sources: [],
  };
  const searchQueries: string[] = [];

  for (const query of queries) {
    try {
      searchQueries.push(query);
      const results = await webSearch(query);

      // Extract median home price
      const priceMatch = results.match(/median\s+(?:home\s+)?(?:price|value)[:\s]+\$?([\d,]+)/i);
      if (priceMatch && !neighborhood.medianHomePrice) {
        neighborhood.medianHomePrice = parsePrice(priceMatch[1]);
        neighborhood.sources.push('web search - median price');
      }

      // Extract median income
      const incomeMatch = results.match(/median\s+(?:household\s+)?income[:\s]+\$?([\d,]+)/i);
      if (incomeMatch && !neighborhood.medianIncome) {
        neighborhood.medianIncome = parsePrice(incomeMatch[1]);
        neighborhood.sources.push('web search - income');
      }

      // Extract population
      const popMatch = results.match(/population[:\s]+([\d,]+)/i);
      if (popMatch && !neighborhood.population) {
        neighborhood.population = parseNum(popMatch[1]?.replace(',', ''));
        neighborhood.sources.push('web search - population');
      }

      // Extract walk score
      const walkMatch = results.match(/walk\s*score[:\s]+(\d+)/i);
      if (walkMatch && !neighborhood.walkScore) {
        neighborhood.walkScore = parseNum(walkMatch[1]);
        neighborhood.sources.push('web search - walk score');
      }
    } catch (error) {
      log.error('search', 'neighborhood_search_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { neighborhood, queries: searchQueries };
}

/**
 * Search for school information
 */
export async function searchSchools(
  property: PropertyAddress,
  webSearch: WebSearchFn
): Promise<{ schools: SchoolInfo[]; queries: string[] }> {
  const { city, state, zip } = property;
  const query = `schools near ${property.address} ${city} ${state} ${zip} ratings`;

  const schools: SchoolInfo[] = [];
  const searchQueries = [query];

  try {
    const results = await webSearch(query);

    // Look for school names with ratings
    const schoolMatches = results.matchAll(
      /([A-Z][A-Za-z\s]+(?:Elementary|Middle|High|School))[^\n]*?(?:rating|score)[:\s]+(\d+)/gi
    );

    for (const match of schoolMatches) {
      const name = match[1].trim();
      const rating = parseNum(match[2]);

      // Determine school type
      let type: SchoolInfo['type'] = 'elementary';
      if (/middle/i.test(name)) type = 'middle';
      else if (/high/i.test(name)) type = 'high';

      if (!schools.find(s => s.name === name)) {
        schools.push({
          name,
          type,
          rating,
          source: 'web search',
        });
      }
    }
  } catch (error) {
    log.error('search', 'schools_search_error', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { schools: schools.slice(0, 10), queries: searchQueries };
}

/**
 * Search for assessor/tax records
 */
export async function searchAssessor(
  property: PropertyAddress,
  webSearch: WebSearchFn
): Promise<{ assessor: AssessorInfo | null; queries: string[] }> {
  const { address, city, state } = property;
  const county = property.county || city;
  const queries = [
    `"${address}" ${city} ${state} property tax records`,
    `${county} county ${state} assessor "${address}"`,
  ];

  let assessor: AssessorInfo | null = null;
  const searchQueries: string[] = [];

  for (const query of queries) {
    try {
      searchQueries.push(query);
      const results = await webSearch(query);

      // Extract assessed value
      const valueMatch = results.match(/assessed\s+value[:\s]+\$?([\d,]+)/i);
      const taxMatch = results.match(/(?:property\s+)?tax(?:es)?[:\s]+\$?([\d,]+)/i);
      const yearMatch = results.match(/year\s+built[:\s]+(\d{4})/i);
      const lotMatch = results.match(/lot\s+size[:\s]+([\d,.]+\s*(?:acres?|sq\s*ft)?)/i);

      if (valueMatch || taxMatch || yearMatch) {
        assessor = {
          assessedValue: parsePrice(valueMatch?.[1]),
          taxAmount: parsePrice(taxMatch?.[1]),
          yearBuilt: parseNum(yearMatch?.[1]),
          lotSize: lotMatch?.[1],
          source: 'web search',
        };

        // Look for assessor website URL
        const urlMatch = results.match(/https?:\/\/[^\s)]+(?:assessor|property|tax)[^\s)]*/i);
        if (urlMatch) {
          assessor.url = urlMatch[0];
        }

        break;
      }
    } catch (error) {
      log.error('search', 'assessor_search_error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { assessor, queries: searchQueries };
}

// =============================================================================
// Full Research Execution
// =============================================================================

/**
 * Execute full property research
 */
export async function executeResearch(
  jobId: string,
  webSearch: WebSearchFn
): Promise<PropertyResearchJob | null> {
  const job = await getJob(jobId);
  if (!job) return null;

  // Update status to researching
  await updateJobStatus(jobId, 'researching');

  const findings: PropertyFindings = {
    listings: [],
    comparables: [],
    neighborhood: null,
    schools: [],
    assessor: null,
    searchQueries: [],
    errors: [],
  };

  const progress: ResearchProgress = { ...job.progress };

  try {
    // 1. Search listings
    progress.listings = 'in_progress';
    await updateJobStatus(jobId, 'researching', { progress });

    const listingsResult = await searchListings(job.property, webSearch);
    findings.listings = listingsResult.listings;
    findings.searchQueries.push(...listingsResult.queries);
    progress.listings = 'done';

    // 2. Search comparables
    progress.comparables = 'in_progress';
    await updateJobStatus(jobId, 'researching', { progress });

    const compsResult = await searchComparables(job.property, webSearch);
    findings.comparables = compsResult.comparables;
    findings.searchQueries.push(...compsResult.queries);
    progress.comparables = 'done';

    // 3. Search neighborhood
    progress.demographics = 'in_progress';
    progress.walkability = 'in_progress';
    await updateJobStatus(jobId, 'researching', { progress });

    const neighborhoodResult = await searchNeighborhood(job.property, webSearch);
    findings.neighborhood = neighborhoodResult.neighborhood;
    findings.searchQueries.push(...neighborhoodResult.queries);
    progress.demographics = 'done';
    progress.walkability = 'done';

    // 4. Search schools
    progress.schools = 'in_progress';
    await updateJobStatus(jobId, 'researching', { progress });

    const schoolsResult = await searchSchools(job.property, webSearch);
    findings.schools = schoolsResult.schools;
    findings.searchQueries.push(...schoolsResult.queries);
    progress.schools = 'done';

    // 5. Search assessor records
    progress.assessor = 'in_progress';
    await updateJobStatus(jobId, 'researching', { progress });

    const assessorResult = await searchAssessor(job.property, webSearch);
    findings.assessor = assessorResult.assessor;
    findings.searchQueries.push(...assessorResult.queries);
    progress.assessor = 'done';

    // Generate report
    const report = generateReport(job.property, findings);

    // Update job as completed
    await updateJobStatus(jobId, 'completed', {
      progress,
      findings,
      reportMarkdown: report,
    });

    log.info('job', 'research_completed', { jobId });
    return await getJob(jobId);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    findings.errors.push(errorMsg);

    await updateJobStatus(jobId, 'failed', {
      progress,
      findings,
      error: errorMsg,
    });

    log.error('job', 'research_failed', {
      jobId,
      error: error instanceof Error ? error.message : String(error),
    });
    return await getJob(jobId);
  }
}

// =============================================================================
// Report Generation
// =============================================================================

/**
 * Generate a markdown report from research findings
 */
export function generateReport(
  property: PropertyAddress,
  findings: PropertyFindings
): string {
  const { address, city, state, zip } = property;
  const lines: string[] = [];

  lines.push(`# Property Research Report`);
  lines.push(``);
  lines.push(`## ${address}`);
  lines.push(`${city}, ${state} ${zip}`);
  lines.push(``);
  lines.push(`*Generated: ${new Date().toLocaleDateString()}*`);
  lines.push(``);

  // Listings Section
  lines.push(`---`);
  lines.push(`## Current Listings`);
  lines.push(``);

  if (findings.listings.length === 0) {
    lines.push(`No active listings found for this property.`);
  } else {
    for (const listing of findings.listings) {
      lines.push(`### ${listing.source.charAt(0).toUpperCase() + listing.source.slice(1)}`);
      if (listing.price) {
        lines.push(`- **Price:** $${listing.price.toLocaleString()}`);
      }
      if (listing.beds) lines.push(`- **Beds:** ${listing.beds}`);
      if (listing.baths) lines.push(`- **Baths:** ${listing.baths}`);
      if (listing.sqft) lines.push(`- **Sq Ft:** ${listing.sqft.toLocaleString()}`);
      lines.push(`- **Link:** [View Listing](${listing.url})`);
      lines.push(``);
    }
  }

  // Comparable Sales Section
  lines.push(`---`);
  lines.push(`## Recent Comparable Sales`);
  lines.push(``);

  if (findings.comparables.length === 0) {
    lines.push(`No recent comparable sales found.`);
  } else {
    lines.push(`| Address | Sale Price | Beds | Baths | Sq Ft | $/SqFt |`);
    lines.push(`|---------|------------|------|-------|-------|--------|`);
    for (const comp of findings.comparables) {
      const ppsf = comp.sqft && comp.salePrice ? Math.round(comp.salePrice / comp.sqft) : '-';
      lines.push(
        `| ${comp.address} | $${comp.salePrice.toLocaleString()} | ${comp.beds || '-'} | ${comp.baths || '-'} | ${comp.sqft?.toLocaleString() || '-'} | ${ppsf} |`
      );
    }
  }
  lines.push(``);

  // Neighborhood Section
  lines.push(`---`);
  lines.push(`## Neighborhood Overview`);
  lines.push(``);

  const n = findings.neighborhood;
  if (n) {
    if (n.medianHomePrice) {
      lines.push(`- **Median Home Price:** $${n.medianHomePrice.toLocaleString()}`);
    }
    if (n.medianIncome) {
      lines.push(`- **Median Household Income:** $${n.medianIncome.toLocaleString()}`);
    }
    if (n.population) {
      lines.push(`- **Population:** ${n.population.toLocaleString()}`);
    }
    if (n.walkScore) {
      lines.push(`- **Walk Score:** ${n.walkScore}/100`);
    }
    if (n.transitScore) {
      lines.push(`- **Transit Score:** ${n.transitScore}/100`);
    }
    if (n.crimeRate) {
      lines.push(`- **Crime Rate:** ${n.crimeRate}`);
    }
  } else {
    lines.push(`Neighborhood data not available.`);
  }
  lines.push(``);

  // Schools Section
  lines.push(`---`);
  lines.push(`## Nearby Schools`);
  lines.push(``);

  if (findings.schools.length === 0) {
    lines.push(`No school information found.`);
  } else {
    lines.push(`| School | Type | Rating |`);
    lines.push(`|--------|------|--------|`);
    for (const school of findings.schools) {
      const ratingStr = school.rating ? `${school.rating}/10` : 'N/A';
      lines.push(`| ${school.name} | ${school.type} | ${ratingStr} |`);
    }
  }
  lines.push(``);

  // Assessor Section
  lines.push(`---`);
  lines.push(`## Tax & Assessor Information`);
  lines.push(``);

  const a = findings.assessor;
  if (a) {
    if (a.assessedValue) {
      lines.push(`- **Assessed Value:** $${a.assessedValue.toLocaleString()}`);
    }
    if (a.taxAmount) {
      lines.push(`- **Annual Property Tax:** $${a.taxAmount.toLocaleString()}`);
    }
    if (a.yearBuilt) {
      lines.push(`- **Year Built:** ${a.yearBuilt}`);
    }
    if (a.lotSize) {
      lines.push(`- **Lot Size:** ${a.lotSize}`);
    }
    if (a.zoning) {
      lines.push(`- **Zoning:** ${a.zoning}`);
    }
    if (a.url) {
      lines.push(`- **Source:** [Assessor Records](${a.url})`);
    }
  } else {
    lines.push(`Assessor data not available.`);
  }
  lines.push(``);

  // Footer
  lines.push(`---`);
  lines.push(`*This report was generated using publicly available web data.*`);
  lines.push(`*${findings.searchQueries.length} searches performed.*`);

  if (findings.errors.length > 0) {
    lines.push(``);
    lines.push(`**Note:** Some data could not be retrieved: ${findings.errors.join(', ')}`);
  }

  return lines.join('\n');
}
