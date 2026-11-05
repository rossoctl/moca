def handler(request):
    name = request.args.get("name", "world")
    return "hello " + name
