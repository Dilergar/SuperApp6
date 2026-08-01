'use client';

// ============================================================
// Лента «Фото»: настоящая лента по датам с justified-раскладкой.
//
// Раскладку считаем сами (~40 строк): ряд набирается по суммарному соотношению
// сторон, пока не заполнит ширину, — так плитки не обрезаются и не «прыгают».
// Виртуализируем РЯДЫ, а не плитки: у ряда постоянная высота, и виртуализатору
// не приходится перемерять каждую картинку.
//
// Сервер отдаёт страницу КОЛОНКАМИ и уже с подписанными ссылками, поэтому ни одна
// плитка не ходит за своей ссылкой отдельно.
// ============================================================

import { useEffect, useMemo, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Virtuoso } from 'react-virtuoso';
import { Chip, EmptyState, Spinner } from '@/components/ui';
import { drivePhotoBucketsKey, drivePhotosKey, type DriveRef } from '@/lib/queries';
import { fetchPhotoBuckets, fetchPhotoPage } from '@/lib/drive-api';
import { useQuery } from '@tanstack/react-query';
import { monthLabel } from './drive-ui';

interface Tile {
  id: string;
  name: string;
  ratio: number;
  url: string | null;
  takenAtLocal: string;
}

interface Row {
  tiles: Array<Tile & { w: number }>;
  height: number;
  /** Заголовок месяца перед рядом (первый ряд месяца) */
  month?: string;
}

const TARGET_ROW_HEIGHT = 180;
const GAP = 6;

/** Собрать ряды: добираем плитки, пока суммарная ширина не перерастёт контейнер */
function layout(tiles: Tile[], width: number): Row[] {
  const rows: Row[] = [];
  let current: Tile[] = [];
  let ratioSum = 0;
  let lastMonth = '';

  const flush = (tail: boolean) => {
    if (!current.length) return;
    // Высота ряда = (ширина − зазоры) / сумма соотношений. У последнего ряда
    // растягивать нечего — оставляем целевую высоту, иначе три снимка расползлись
    // бы на весь экран.
    const avail = width - GAP * (current.length - 1);
    const h = tail && ratioSum < width / TARGET_ROW_HEIGHT ? TARGET_ROW_HEIGHT : avail / ratioSum;
    const month = current[0].takenAtLocal.slice(0, 7);
    rows.push({
      tiles: current.map((t) => ({ ...t, w: Math.floor(h * t.ratio) })),
      height: Math.round(h),
      month: month !== lastMonth ? month : undefined,
    });
    lastMonth = month;
    current = [];
    ratioSum = 0;
  };

  for (const t of tiles) {
    const month = t.takenAtLocal.slice(0, 7);
    if (current.length && month !== current[0].takenAtLocal.slice(0, 7)) flush(false);
    current.push(t);
    ratioSum += t.ratio || 1;
    if (ratioSum >= width / TARGET_ROW_HEIGHT) flush(false);
  }
  flush(true);
  return rows;
}

export function PhotoTimeline({ driveRef }: { driveRef: DriveRef }) {
  const [month, setMonth] = useState<string | undefined>(undefined);
  const [width, setWidth] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // Ширина контейнера нужна ДО раскладки, поэтому меряем её, а не гадаем.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const { data: buckets } = useQuery({
    queryKey: drivePhotoBucketsKey(driveRef),
    queryFn: () => fetchPhotoBuckets(driveRef),
  });

  const query = useInfiniteQuery({
    queryKey: drivePhotosKey(driveRef, month),
    queryFn: ({ pageParam }) => fetchPhotoPage(driveRef, { month, cursor: pageParam as string | undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const tiles = useMemo<Tile[]>(() => {
    const out: Tile[] = [];
    for (const page of query.data?.pages ?? []) {
      for (let i = 0; i < page.id.length; i++) {
        out.push({
          id: page.id[i],
          name: page.name[i],
          ratio: page.ratio[i] || 1,
          url: page.url[i],
          takenAtLocal: page.takenAtLocal[i],
        });
      }
    }
    return out;
  }, [query.data]);

  const rows = useMemo(() => (width > 0 ? layout(tiles, width) : []), [tiles, width]);

  return (
    <div>
      {/* Скруббер: месяцы приходят готовыми счётчиками, весь ответ — единицы КБ */}
      {(buckets ?? []).length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
          <Chip tone="accent" selected={!month} onClick={() => setMonth(undefined)}>
            Все
          </Chip>
          {(buckets ?? []).map((b) => (
            <Chip key={b.month} tone="accent" selected={month === b.month} onClick={() => setMonth(b.month)}>
              {monthLabel(b.month)} · {b.count}
            </Chip>
          ))}
        </div>
      )}

      <div ref={boxRef}>
        {query.isPending ? (
          <div style={{ padding: 24, display: 'flex', justifyContent: 'center' }}>
            <Spinner />
          </div>
        ) : tiles.length === 0 ? (
          <EmptyState
            icon="image"
            title="Снимков пока нет"
            description="Фотографии, попавшие на Диск, выстроятся здесь по датам съёмки"
          />
        ) : (
          <Virtuoso
            data={rows}
            style={{ height: 'min(70vh, 760px)' }}
            computeItemKey={(i, row) => row.tiles[0]?.id ?? String(i)}
            increaseViewportBy={{ top: 300, bottom: 600 }}
            endReached={() => {
              if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
            }}
            itemContent={(_i, row) => (
              // Отступ ВНУТРИ ряда: виртуализатор меряет offsetHeight, внешние margin в него не входят
              <div style={{ paddingBottom: GAP }}>
                {row.month && (
                  <p className="label-caps" style={{ margin: '10px 0 6px' }}>
                    {monthLabel(row.month)}
                  </p>
                )}
                <div style={{ display: 'flex', gap: GAP }}>
                  {row.tiles.map((t) => (
                    <div
                      key={t.id}
                      title={t.name}
                      style={{
                        width: t.w,
                        height: row.height,
                        borderRadius: 'var(--radius-md)',
                        overflow: 'hidden',
                        background: 'var(--active)',
                        flexShrink: 0,
                      }}
                    >
                      {t.url && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={t.url}
                          alt={t.name}
                          loading="lazy"
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          />
        )}
      </div>
    </div>
  );
}
