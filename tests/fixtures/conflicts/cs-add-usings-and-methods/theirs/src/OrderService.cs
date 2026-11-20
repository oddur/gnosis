using System;
using System.Collections.Generic;
using System.Text;

namespace Lab.Orders
{
    public class OrderService
    {
        private readonly List<string> _orders = new();

        public void Add(string order)
        {
            _orders.Add(order);
        }

        public string Describe() => new StringBuilder().AppendJoin(",", _orders).ToString();
    }
}
