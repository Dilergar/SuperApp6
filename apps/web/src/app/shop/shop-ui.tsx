'use client';

// ============================================================
// Витринные кирпичи Магазина: прогресс сбора (штриховой), карточка лота,
// галерея фото лота. Используются страницей и вишлистом.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { api, apiErrorMessage } from '@/lib/api';
import { useFileUpload } from '@/lib/hooks/useFileUpload';
import { FileDropzone } from '@/components/files/FileDropzone';
import { UploadProgressList } from '@/components/files/UploadProgressList';
import {
  Button, Card, Chip, EmojiIcon, Field, IconButton, TickBar,
} from '@/components/ui';
import {
  LISTING_ITEM_TYPE_LABELS,
  SHOP_LIMITS,
  type ContributionLine,
  type FileDto,
  type Listing,
  type ListingPriceDto,
} from '@superapp/shared';
import { fmtAmount, fmtPrices, listingAvailability, progressLines } from './shop-lib';

/** Прогресс сбора по каждой валюте цели — фирменными штрихами (DESIGN.md §5). */
export function CampaignBars({ prices, raised }: { prices: ListingPriceDto[]; raised?: ContributionLine[] }) {
  return (
    <div style={{ display: 'grid', gap: '0.5rem', margin: 'var(--spacing-3) 0' }}>
      {progressLines(prices, raised).map((l) => {
        const pct = l.amount > 0 ? Math.min(100, Math.round((l.raised / l.amount) * 100)) : 0;
        return (
          <div key={l.currencyId}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }} className="label-sm">
              <span>
                <span aria-hidden>{l.currencyIcon}</span> {fmtAmount(l.raised, l.scale)} / {fmtAmount(l.amount, l.scale)}
              </span>
              <span style={{ fontWeight: 700 }}>{pct}%</span>
            </div>
            <TickBar
              value={pct}
              tone={pct >= 100 ? 'success' : 'accent'}
              height={9}
              style={{ marginTop: '0.25rem' }}
              aria-label={`Собрано ${pct}% в ${l.currencyName}`}
            />
          </div>
        );
      })}
    </div>
  );
}

/** Цена лота: зачёркнутая старая + новая, когда действует FOMO-скидка. */
function PriceLine({ listing }: { listing: Listing }) {
  const { discountActive, effPrices } = listingAvailability(listing);
  return (
    <div style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: '1.05rem', color: 'var(--primary-dim)' }}>
      {discountActive ? (
        <>
          <span style={{ textDecoration: 'line-through', opacity: 0.5, fontWeight: 500, fontSize: '0.8em', marginRight: '0.4rem' }}>
            {fmtPrices(listing.prices)}
          </span>
          {fmtPrices(effPrices)}
        </>
      ) : (
        fmtPrices(listing.prices)
      )}
    </div>
  );
}

export function ListingCard({
  l,
  canManage,
  onEdit,
  onDelete,
  onBuy,
  onTalk,
  onForward,
  onContribute,
}: {
  l: Listing;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onBuy?: () => void;
  onTalk?: () => void;
  onForward?: () => void;
  onContribute?: () => void;
}) {
  const iPledged = (l.campaign?.myContribution?.length ?? 0) > 0;
  const { discountActive, remaining, soldOut, notYet, closed, sellable, reason } = listingAvailability(l);

  return (
    <Card small style={{ position: 'relative', opacity: l.status === 'archived' ? 0.55 : 1 }}>
      {onForward && (
        <IconButton
          icon="share"
          label="Переслать в чат"
          size={30}
          variant="outline"
          round={false}
          onClick={onForward}
          style={{ position: 'absolute', top: 'var(--spacing-3)', right: 'var(--spacing-3)', zIndex: 1, background: 'var(--block)' }}
        />
      )}

      {l.coverUrl ? (
        // Обложка = первое фото галереи (движок файлов, публичный класс); эмодзи — фолбэк
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={l.coverUrl}
          alt={l.title}
          style={{ width: '100%', height: '8.5rem', objectFit: 'cover', borderRadius: 'var(--radius-md)', marginBottom: 'var(--spacing-3)', display: 'block' }}
        />
      ) : (
        <div style={{ marginBottom: 'var(--spacing-3)' }}>
          {/* Эмодзи лота выбирает владелец — это данные, иконкой не заменяем */}
          <EmojiIcon emoji={l.icon} size={44} square tone="accent" fallback="gift" />
        </div>
      )}

      <div className="title-sm">{l.title}</div>
      {l.description && <p className="label-sm" style={{ margin: '0.25rem 0 0' }}>{l.description}</p>}

      <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', margin: 'var(--spacing-3) 0' }}>
        <Chip size="sm" tone="neutral">{LISTING_ITEM_TYPE_LABELS[l.itemType]}</Chip>
        {l.withTask && (
          <Chip size="sm" tone="neutral" icon="tasks">С задачей{l.taskDays ? ` · ${l.taskDays}д` : ''}</Chip>
        )}
        {l.crowdfunding && <Chip size="sm" tone="accent" icon="target">Сбор</Chip>}
        {discountActive && <Chip size="sm" tone="warning" icon="bolt">−{l.discountPercent}%</Chip>}
        {remaining != null && (
          <Chip size="sm" tone={soldOut ? 'danger' : 'neutral'}>
            {soldOut ? 'Распродано' : `осталось ${remaining}`}
          </Chip>
        )}
        {closed && <Chip size="sm" tone="neutral" icon="clock">Закрыто</Chip>}
        {notYet && <Chip size="sm" tone="neutral" icon="clock">Скоро</Chip>}
      </div>

      <PriceLine listing={l} />
      {l.crowdfunding && <CampaignBars prices={l.prices} raised={l.campaign?.raised} />}

      {canManage ? (
        <div style={{ display: 'flex', gap: '0.375rem', marginTop: 'var(--spacing-3)' }}>
          <Button variant="outline" size="sm" icon="edit" onClick={onEdit}>Изменить</Button>
          <Button variant="ghost" size="sm" tone="danger" icon="delete" onClick={onDelete}>Удалить</Button>
        </div>
      ) : l.crowdfunding && onContribute ? (
        <div style={{ marginTop: 'var(--spacing-3)' }}>
          {sellable ? (
            <Button variant="primary" size="sm" icon="target" onClick={onContribute}>
              {iPledged ? 'Мой вклад' : 'Скинуться'}
            </Button>
          ) : (
            <Chip size="sm" tone="neutral">{reason}</Chip>
          )}
        </div>
      ) : onBuy || onTalk ? (
        <div style={{ marginTop: 'var(--spacing-3)', display: 'flex', gap: '0.375rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {onBuy && (sellable ? (
            <Button variant="primary" tone="success" size="sm" icon="coins" onClick={onBuy}>Купить</Button>
          ) : (
            <Chip size="sm" tone="neutral">{reason}</Chip>
          ))}
          {onTalk && <Button variant="ghost" size="sm" icon="messenger" onClick={onTalk}>Поговорить</Button>}
        </div>
      ) : null}
    </Card>
  );
}

/** Галерея фото лота внутри формы: грид тумбов с крестиком + дропзона (≤10). */
export function ListingPhotosSection({ listingId, onError }: { listingId: string; onError: (m: string) => void }) {
  const [images, setImages] = useState<FileDto[]>([]);
  const reload = useCallback(() => {
    api.get(`/shop/listings/${listingId}/images`).then((r) => setImages(r.data.data)).catch(() => {});
  }, [listingId]);
  useEffect(() => { reload(); }, [reload]);

  const uploader = useFileUpload('listing_image', {
    onUploaded: (f) => {
      api.post(`/shop/listings/${listingId}/images`, { fileId: f.id })
        .then((r) => setImages(r.data.data))
        .catch((e) => onError(apiErrorMessage(e)));
    },
  });
  const remove = (fileId: string) => {
    api.delete(`/shop/listings/${listingId}/images/${fileId}`).then(reload).catch((e) => onError(apiErrorMessage(e)));
  };
  const thumbOf = (f: FileDto) =>
    f.publicUrl ? `${f.publicUrl}${f.variants?.some((v) => v.kind === 'thumb') ? '?variant=thumb' : ''}` : '';

  return (
    <Field label={`Фото (до ${SHOP_LIMITS.maxListingImages}; первое — обложка)`}>
      {images.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem', marginBottom: '0.5rem' }}>
          {images.map((f) => (
            <div
              key={f.id}
              style={{
                position: 'relative', width: 64, height: 64, borderRadius: 'var(--radius-md)',
                overflow: 'hidden', background: 'var(--surface-container)',
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={thumbOf(f)} alt={f.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              <IconButton
                icon="close"
                label={`Убрать фото ${f.name}`}
                size={20}
                iconSize={11}
                variant="outline"
                onClick={() => remove(f.id)}
                style={{ position: 'absolute', top: 2, right: 2, background: 'var(--block)' }}
              />
            </div>
          ))}
        </div>
      )}
      {images.length < SHOP_LIMITS.maxListingImages && (
        <FileDropzone
          onFiles={(fs) => uploader.add(fs.slice(0, SHOP_LIMITS.maxListingImages - images.length))}
          accept="image/*"
          multiple
          compact
          label="Добавить фото"
        />
      )}
      <UploadProgressList items={uploader.items.filter((i) => i.status !== 'done')} onCancel={uploader.cancel} onRemove={uploader.remove} />
    </Field>
  );
}
