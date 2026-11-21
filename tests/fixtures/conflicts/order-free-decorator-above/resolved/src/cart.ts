export class Cart {
  total() {
    return 0;
  }

  @memo
  add(item: string) {
    return item;
  }

  remove(id: number) {
    return id;
  }

  later() {
    return 1;
  }
}
