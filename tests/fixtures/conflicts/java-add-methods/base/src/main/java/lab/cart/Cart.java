package lab.cart;

import java.util.ArrayList;
import java.util.List;

public class Cart {
    private final List<Integer> prices = new ArrayList<>();

    public void add(int price) {
        prices.add(price);
    }
}
