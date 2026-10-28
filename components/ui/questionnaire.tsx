// shadcn Questionnaire primitives, using the existing Gnosis controls and tokens.
// https://ui.shadcn.com/docs/components/base/questionnaire
import * as React from 'react';
import { Questionnaire as Primitive } from '@shadcn/react/questionnaire';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonVariants } from './button';
export const Questionnaire = Primitive.Root;
export const QuestionnaireItem = Primitive.Item;
export const QuestionnaireTitle = Primitive.Title;
export const QuestionnaireDescription = Primitive.Description;
export const QuestionnaireProgress = Primitive.Progress;
export const QuestionnaireChoices = Primitive.Choices;
export function QuestionnaireChoice({ children, className, ...props }: React.ComponentProps<typeof Primitive.Choice>) {
  return (
    <Primitive.Choice className={cn('setup-choice', className)} {...props}>
      <Primitive.ChoiceInput className="setup-choice-input" />
      <span className="setup-choice-check" aria-hidden="true">
        <Check size={13} />
      </span>
      <span>{children}</span>
    </Primitive.Choice>
  );
}
export function QuestionnairePrevious(props: React.ComponentProps<typeof Primitive.Previous>) {
  return <Primitive.Previous className={buttonVariants({ variant: 'outline' })} {...props} />;
}
export function QuestionnaireNext(props: React.ComponentProps<typeof Primitive.Next>) {
  return <Primitive.Next className={buttonVariants()} {...props} />;
}
export function QuestionnaireSubmit(props: React.ComponentProps<typeof Primitive.Submit>) {
  return <Primitive.Submit className={buttonVariants()} {...props} />;
}
