/**
 * Property research types
 */

// ============================================================================
// Property Research System
// ============================================================================

/**
 * Property address for research
 */
export interface PropertyAddress {
  address: string;
  city: string;
  state: string;
  zip: string;
  county?: string;
}

/**
 * Research progress tracking
 */
export type ResearchStepStatus = 'pending' | 'in_progress' | 'done' | 'failed';

export interface ResearchProgress {
  listings: ResearchStepStatus;
  assessor: ResearchStepStatus;
  comparables: ResearchStepStatus;
  demographics: ResearchStepStatus;
  schools: ResearchStepStatus;
  walkability: ResearchStepStatus;
}

/**
 * Property listing found via web search
 */
export interface PropertyListing {
  source: string;           // zillow, redfin, realtor.com, etc.
  url: string;
  price?: number;
  priceStr?: string;
  beds?: number;
  baths?: number;
  sqft?: number;
  lotSize?: string;
  yearBuilt?: number;
  propertyType?: string;    // single-family, condo, townhouse, etc.
  status?: string;          // for sale, pending, sold
  daysOnMarket?: number;
  description?: string;
  imageUrl?: string;
}

/**
 * Comparable sale (comp)
 */
export interface ComparableSale {
  address: string;
  salePrice: number;
  saleDate: string;
  beds?: number;
  baths?: number;
  sqft?: number;
  pricePerSqft?: number;
  distanceMiles?: number;
  source: string;
  url?: string;
}

/**
 * Neighborhood/demographic info
 */
export interface NeighborhoodInfo {
  medianHomePrice?: number;
  medianRent?: number;
  medianIncome?: number;
  population?: number;
  crimeRate?: string;        // low, medium, high, or score
  walkScore?: number;
  transitScore?: number;
  bikeScore?: number;
  sources: string[];
}

/**
 * School info
 */
export interface SchoolInfo {
  name: string;
  type: 'elementary' | 'middle' | 'high' | 'private' | 'charter';
  rating?: number;           // 1-10 scale
  distance?: string;
  enrollment?: number;
  source: string;
  url?: string;
}

/**
 * Assessor/tax record info
 */
export interface AssessorInfo {
  assessedValue?: number;
  taxAmount?: number;
  taxYear?: number;
  lotSize?: string;
  yearBuilt?: number;
  zoning?: string;
  ownerName?: string;        // Public record
  lastSaleDate?: string;
  lastSalePrice?: number;
  source: string;
  url?: string;
}

/**
 * All research findings for a property
 */
export interface PropertyFindings {
  listings: PropertyListing[];
  comparables: ComparableSale[];
  neighborhood: NeighborhoodInfo | null;
  schools: SchoolInfo[];
  assessor: AssessorInfo | null;
  searchQueries: string[];   // Queries used for audit
  errors: string[];          // Any errors encountered
}

/**
 * Property research job status
 */
export type PropertyResearchStatus = 'queued' | 'researching' | 'completed' | 'failed';

/**
 * Property research job record (DynamoDB)
 * Key: pk=PROPERTY_RESEARCH#{jobId}, sk=JOB
 */
export interface PropertyResearchJob {
  pk: string;
  sk: string;
  jobId: string;
  avatarId: string;
  requestedBy?: string;      // Wallet address or user ID

  // Property being researched
  property: PropertyAddress;

  // Job status
  status: PropertyResearchStatus;
  progress: ResearchProgress;

  // Research findings (populated as research progresses)
  findings?: PropertyFindings;

  // Generated report
  reportMarkdown?: string;
  reportUrl?: string;        // S3 URL if stored externally

  // Timestamps
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  error?: string;

  // TTL for auto-cleanup (7 days)
  ttl: number;

  // GSI for avatar queries: gsi2pk=AVATAR#{avatarId}, gsi2sk={status}#{createdAt}
  gsi2pk: string;
  gsi2sk: string;
}

/**
 * Property research authorization grant
 * Key: pk=PROPERTY_AUTH#{avatarId}, sk=USER#{walletAddress}
 */
export interface PropertyResearchAuth {
  pk: string;
  sk: string;
  avatarId: string;
  walletAddress: string;
  grantedAt: number;
  expiresAt: number;         // 24-hour grants by default
  ttl: number;
}
