export class Cart {
  total() {
    return 0;
  }

  @memo
  remove(id: number) {
    return id;
  }

  later() {
    return 1;
  }
}
