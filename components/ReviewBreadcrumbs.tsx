import { Fragment, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Popover } from 'radix-ui';
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
  BreadcrumbEllipsis,
} from './ui/breadcrumb';
import { SearchableSelect } from './SearchableSelect';
import { useReviewTrail, type ReviewCrumb } from '../lib/review-breadcrumbs';

function Segment({ crumb, current = false }: { crumb: ReviewCrumb; current?: boolean }) {
  const picker = !!crumb.select && !!crumb.options?.length;
  return (
    <>
      {crumb.navigate ? (
        <BreadcrumbLink render={<button type="button" onClick={crumb.navigate} title={crumb.title ?? crumb.label} />}>
          {crumb.label}
        </BreadcrumbLink>
      ) : !picker ? (
        <BreadcrumbPage title={crumb.title ?? crumb.label} aria-current={current ? 'page' : undefined}>
          {crumb.label}
        </BreadcrumbPage>
      ) : null}
      {picker && (
        <SearchableSelect
          label={crumb.pickerLabel ?? `Choose ${crumb.id}`}
          value={crumb.value ?? ''}
          options={
            crumb.value && !crumb.options?.some((option) => option.value === crumb.value)
              ? [{ value: crumb.value, label: crumb.title ?? crumb.label }, ...(crumb.options ?? [])]
              : (crumb.options ?? [])
          }
          onValueChange={(value) => crumb.select?.(value)}
          triggerLabel={crumb.navigate ? '' : crumb.label}
          current={current}
          className={crumb.navigate ? 'breadcrumb-picker breadcrumb-chevron' : 'breadcrumb-picker'}
        />
      )}
    </>
  );
}

/** A single-height location trail. Overflow keeps the origin and current content visible. */
export function ReviewBreadcrumbs({ base, scope }: { base: ReviewCrumb[]; scope: string }) {
  const detail = useReviewTrail(scope);
  const crumbs = [...base, ...detail];
  const container = useRef<HTMLElement>(null);
  const measure = useRef<HTMLOListElement>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const signature = JSON.stringify(crumbs.map((c) => [c.id, c.label]));
  useLayoutEffect(() => {
    const root = container.current,
      natural = measure.current;
    if (!root || !natural) return;
    const check = () => setCollapsed(crumbs.length > 2 && natural.scrollWidth > root.clientWidth);
    const observer = new ResizeObserver(check);
    observer.observe(root);
    observer.observe(natural);
    check();
    return () => observer.disconnect();
  }, [signature]);
  const visible = collapsed ? [crumbs[0], crumbs[crumbs.length - 1]] : crumbs;
  return (
    <Breadcrumb ref={container} aria-label="Review location" className="review-breadcrumbs">
      <ol ref={measure} className="breadcrumb-measure" aria-hidden="true" inert>
        {crumbs.map((crumb) => (
          <li key={crumb.id}>
            <span>{crumb.label}</span>
            {crumb.select && <ChevronDown size={14} />}
            <ChevronRight size={14} />
          </li>
        ))}
      </ol>
      <BreadcrumbList>
        {visible.map((crumb, index) => (
          <Fragment key={crumb.id}>
            {index > 0 && <BreadcrumbSeparator />}
            {collapsed && index === 1 && (
              <>
                <BreadcrumbItem className="breadcrumb-overflow">
                  <Popover.Root open={moreOpen} onOpenChange={setMoreOpen}>
                    <Popover.Trigger aria-label="Show full review hierarchy" title="Show full review hierarchy">
                      <BreadcrumbEllipsis />
                    </Popover.Trigger>
                    <Popover.Portal>
                      <Popover.Content
                        className="breadcrumb-overflow-menu"
                        align="start"
                        sideOffset={6}
                        onInteractOutside={(event) => {
                          if (event.target instanceof Element && event.target.closest('[data-slot="combobox-content"]'))
                            event.preventDefault();
                        }}
                        onEscapeKeyDown={(event) => {
                          if ((event.target as Element).closest('[data-slot="combobox-content"]'))
                            event.preventDefault();
                        }}
                      >
                        <p className="text-sm font-medium">Review location</p>
                        <ol>
                          {crumbs.slice(1, -1).map((hidden) => (
                            <li key={hidden.id}>
                              <Segment
                                crumb={{
                                  ...hidden,
                                  navigate: hidden.navigate
                                    ? () => {
                                        hidden.navigate?.();
                                        setMoreOpen(false);
                                      }
                                    : undefined,
                                  select: hidden.select
                                    ? (value) => {
                                        hidden.select?.(value);
                                        setMoreOpen(false);
                                      }
                                    : undefined,
                                }}
                              />
                            </li>
                          ))}
                        </ol>
                      </Popover.Content>
                    </Popover.Portal>
                  </Popover.Root>
                </BreadcrumbItem>
                <BreadcrumbSeparator />
              </>
            )}
            <BreadcrumbItem>
              <Segment crumb={crumb} current={index === visible.length - 1} />
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
