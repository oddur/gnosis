export class Bag {
  size() {
    return 0;
  }

  add(item: string) {
    return item;
  }

  [key](item: string) {
    return item.length;
  }
}
