export class Cart {
  total() {
    return 0;
  }

  @memo
  add(item: string) {
    return item;
  }

  later() {
    return 1;
  }
}
