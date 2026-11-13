export interface PaginationMeta {
  page?: number;
  limit: number;
  total?: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface ResponseLinks {
  self: string;
  next: string | null;
  prev: string | null;
}

export interface ApiEnvelope<T> {
  data: T;
  meta: PaginationMeta;
  links: ResponseLinks;
}

export const buildEnvelope = <T>(input: {
  data: T;
  self: string;
  limit: number;
  page?: number;
  total?: number;
  nextCursor?: string | null;
  hasMore?: boolean;
  next?: string | null;
  prev?: string | null;
}): ApiEnvelope<T> => {
  const meta: PaginationMeta = {
    limit: input.limit,
    nextCursor: input.nextCursor ?? null,
    hasMore: input.hasMore ?? false,
  };
  if (input.page !== undefined) meta.page = input.page;
  if (input.total !== undefined) meta.total = input.total;
  return {
    data: input.data,
    meta,
    links: { self: input.self, next: input.next ?? null, prev: input.prev ?? null },
  };
};

export const toIsoString = (value: Date | string | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  return (typeof value === 'string' ? new Date(value) : value).toISOString();
};
