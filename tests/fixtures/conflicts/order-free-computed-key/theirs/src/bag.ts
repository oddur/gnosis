export class Bag {
  size() {
    return 0;
  }

  [key](item: string) {
    return item.length;
  }
}
