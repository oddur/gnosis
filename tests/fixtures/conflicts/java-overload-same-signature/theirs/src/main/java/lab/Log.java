package lab;

public class Log {
    public void write(String m) {
        System.out.println(m);
    }

    public void write(int code) {
        write(Integer.toString(code));
    }
}
