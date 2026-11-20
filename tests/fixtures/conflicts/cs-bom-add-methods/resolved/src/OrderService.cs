using System;
using System.Collections.Generic;

namespace Lab.Orders
{
    public class OrderService
    {
        private readonly List<string> _orders = new();

        public void Add(string order)
        {
            _orders.Add(order);
        }

        public int Count() => _orders.Count;

        public void Clear() => _orders.Clear();
    }
}
